"use strict";

const crypto = require("crypto");
const path = require("path");
const { fork, ChildProcess } = require("child_process");

/* defaults */
let MESSAGE_TIMEOUT = 3000; // default timeout dispatch: 3s
let MESSAGE_DELAY = 20;
let JENGINE = null;

/* logger */
if (!global.LOG) global.LOG = {
	access: (...args) => console.log(...args),
	error: (...args) => console.error(...args),
	warn: (...args) => console.log(...args),
	info: (...args) => console.log(...args),
	debug: (...args) => console.log(...args)
}

class JMessage {
	constructor(name, payload, enqueue, broadcast, timeout) {
		if (typeof name !== "string") throw new Error("Wrong message name.");
		this.id = crypto.randomBytes(14).toString('hex');
		this.type = "request";
		this.name = name;
		this.handled = false;
		this.handlers = [];
		this.result = null;
		this.error = undefined;
		this.timeout = typeof timeout == "number" ? timeout : MESSAGE_TIMEOUT;
		this.broadcast = broadcast ? true : false;
		this.enqueue = enqueue ? true : false;
		this.payload = {};
		if (typeof payload === "object") this.payload = {...payload};
	}

	get(key) {
		return this.payload[key];
	}

	set(key, value) {
		this.payload[key] = value;
	}

}

JMessage.copyObject = function(src, dst) {
	function _doCopy(from, to) {
		for (let key in from) {
			if (key.startsWith("_")) continue;
			if (typeof from[key] == "function") continue;
			if (typeof from[key] == "undefined") continue;
			if (from[key] instanceof Array || typeof from[key] !== "object" || from[key] === null) {
				to[key] = from[key];
			} else {
				to[key] = {};
				_doCopy(src[key], dst[key]);
			}
		}
	}
	if (typeof src == "object" /*&& !(src instanceof Array)*/) {
		_doCopy(src, dst);
	}
	return dst;
}

JMessage.isMessage = function(obj) {
	if (obj instanceof JMessage) return true;

	if (typeof obj === "object" &&
		typeof obj.id === "string" &&
		typeof obj.type === "string" &&
		typeof obj.name === "string" &&
		typeof obj.payload === "object") return true;

	return false;
}

JMessage.create = function(obj) {
	if (typeof obj === "object" && typeof obj.name === "string") {
		let message,
			id,
			name = obj.name,
			type,
			handled = false,
			handlers = [],
			result,
			error,
			timeout,
			broadcast,
			enqueue,
			payload = {};

		for (let key in obj) {
			switch (key) {
				case "id": id = typeof obj[key] === "string" ? obj[key] : undefined; break;
				case "name": name = typeof obj[key] === "string" ? obj[key] : undefined; break;
				case "type": type = typeof obj[key] === "string" ? obj[key] : "request"; break;
				case "handled": handled = typeof obj[key] === "boolean" ? obj[key] : false; break;
				case "handlers": handlers = handlers instanceof Array ? obj[key] : []; break;
				case "result": result = obj[key]; break;
				case "error": error = obj[key]; break;
				case "timeout": timeout = typeof obj[key] === "number" ? obj[key] : undefined; break;
				case "broadcast": broadcast = typeof obj[key] === "boolean" ? obj[key] : false; break;
				case "enqueue": enqueue = typeof obj[key] === "boolean" ? obj[key] : false; break;
				case "payload": payload = typeof obj[key] === "object" ? obj[key] : {}; break;
				default: payload[key] = obj[key];
			}
		}
		message = new JMessage(name, payload, enqueue, broadcast);
		if (id) message.id = id;
		if (type) message.type = type;
		if (handled) message.handled = handled;
		if (timeout) message.timeout = timeout;
		message.result = result;
		message.error = error;

		return message;
	}
	
	throw new Error("Wrong message name.");
}

class JEngine {

	constructor(name) {
		this._modules = [];
		this._installs = new Map(); // message_name, [handlers] ordered by priority
		this._watchers = new Map();
		this.name = name;
	}
	
	getModules() {
		return this._modules;
	}
	getInstalls(message) {
		return this._installs.get(message);
	}
	getWatchers(message) {
		return this._watchers.get(message);
	}
	getMessages() {
		return [...this._installs.keys()];
	}

	load(...args) {
		return new Promise((resolve, reject) => {

			const jmodule = fork(...args); //, {stdio: ['ipc', 'ignore', 'ignore']});
			jmodule.name = path.basename(jmodule.spawnargs[1], ".js");
			jmodule.ready = false;
			jmodule.respawn = true;
			jmodule.selfwatch = false;
			jmodule.selfdispatch = false;
			jmodule.installs = {};
			jmodule.setMaxListeners(200);

			jmodule.sendMessage = function (...args) {
				try {
					if (jmodule.connected && jmodule.channel)
						jmodule.send(...args);
				} catch (err) {
					LOG.info(`Module ${jmodule.name} IPC error`, err.stack);
				}
			};

			jmodule.on("close", (ev) => {
				LOG.info(`Module ${jmodule.name} closed with code: ${ev}`);
			});

			jmodule.on("error", (err) => {
				LOG.error(`Module ${jmodule.name} internal error occur`, err.stack);
			});

			jmodule.on("disconnect", () => {
				LOG.info(`Module ${jmodule.name} has been disconnected.`);
				// Reject if not initialized
				if (!jmodule.ready) {
					reject(`Module ${jmodule.name} has been disconnected.`);
				}
			});
			jmodule.on("spawn", () => {
				//console.log(`Module ${jsmodule.name} loading...`);
				LOG.info(`Module ${jmodule.name} loading...`);
			});

			// respawn
			jmodule.once("exit", (ev) => {
				LOG.info(`Module ${jmodule.name} exited with code ${ev}`);
				this.unsubscribe(jmodule, ev);
				if (ev !== 0 && jmodule.respawn && jmodule.ready)
					setTimeout(() => {
						LOG.info("Try respawn", jmodule.name);
						this.load(...args);
					}, 7000);
			});

			// Setup handler
			jmodule.on("message", (message) => {
				// Resolve load() with any incoming message!
				if (!jmodule.ready) {
					LOG.info(`Module ${jmodule.name} is ready.`);
					jmodule.ready = true;
					resolve(jmodule);
				}

				if (!JMessage.isMessage(message)) {
					LOG.debug(jmodule.name + " -\x1b[31m?\x1b[0m->", JSON.stringify(message));
					return;
				}
				message = JMessage.create(message);
				switch (message.type) {
					case "request":
						if (message.enqueue) {
							LOG.debug(
								jmodule.name +	" -\x1b[31mE\x1b[0m->",
								JSON.stringify(message)
							);
						} else {
							LOG.debug(
								jmodule.name + " -\x1b[31mR\x1b[0m->",
								JSON.stringify(message)
							);
						}
						this._dispatch(message, jmodule)
							.catch((err) => err)
							.then((answer) => {
								//result = SMessage.create(result);
								answer.type =
									answer.type !== "error"
										? "answer"
										: "error";
								answer.handled = answer.handled ? true : false;
								if (!message.enqueue) {
									LOG.debug(
										jmodule.name + " <-\x1b[31mA\x1b[0m-",
										JSON.stringify(answer)
									);
									if (jmodule.connected)
										jmodule.sendMessage(answer);
								}
								return answer;
							})
							.then((notice) => this._notify(notice, jmodule));
						break;
					case "install":
						LOG.debug(
							jmodule.name + " -I->",
							JSON.stringify(message)
						);
						jmodule.installs[message.name] = message.payload.priority;
						this._install(message.name, jmodule);
						break;
					case "uninstall":
						LOG.debug(
							jmodule.name + " -U->",
							JSON.stringify(message)
						);
						this._uninstall(message.name, jmodule);
						break;
					case "watch":
						LOG.debug(
							jmodule.name + " -W->",
							JSON.stringify(message)
						);
						this._watch(message.name, jmodule);
						break;
					case "unwatch":
						LOG.debug(
							jmodule.name + " -U->",
							JSON.stringify(message)
						);
						this._unwatch(message.name, jmodule);
						break;
					case "setlocal":
						LOG.debug(
							jmodule.name + " -S->",
							JSON.stringify(message)
						);
						jmodule.setlocal(message);
						break;
					case "connect":
						LOG.debug(
							jmodule.name + " -C->",
							JSON.stringify(message)
						);
						if (!jmodule.ready) {
							LOG.info(`Module ${jmodule.name} is connected.`);
							jmodule.ready = true;
							resolve(jmodule);
						}
						break;
					default:
						// do nothing
						
							LOG.debug(
								jmodule.name + " -\x1b[32mA\x1b[0m->",
								JSON.stringify(message)
							);
				}
			});

			jmodule.setlocal = function (message) {
				if (typeof message.payload !== "object") return;
				message.handled = true;
				message.result = {};
				for (let key in message.payload) {
					switch (key) {
						case "trackname":
							if (
								typeof message.payload[key] === "string" &&
								message.payload[key].length > 1
							) {
								jmodule.name = message.payload[key];
							}
							message.result[key] = jmodule.name;
							break;
						case "selfwatch":
							if (typeof message.payload[key] === "boolean") {
								jmodule.selfwatch = message.payload[key];
							}
							message.result[key] = jmodule.selfwatch;
							break;
						case "selfdispatch":
							if (typeof message.payload[key] === "boolean") {
								jmodule.selfdispatch = message.payload[key];
							}
							message.result[key] = jmodule.selfdispatch;
							break;
						case "respawn":
							if (typeof message.payload[key] === "boolean") {
								jmodule.respawn = message.payload[key];
							}
							message.result[key] = jmodule.respawn;
							break;
					}
				}
				
					LOG.debug(
						jmodule.name + " <-S-",
						JSON.stringify(message)
					);
				jmodule.sendMessage(message);
			};

			jmodule.enqueue = function (message) {
				
					LOG.debug(
						jmodule.name + " <-\x1b[36mN\x1b[0m-",
						JSON.stringify(message)
					);
				jmodule.sendMessage(message);
				return Promise.resolve(message);
			};

			jmodule.dispatch = function (message) {
				return new Promise((resolve, reject) => {
					let listener;
					let timeout = setTimeout(() => {
						jmodule.removeListener("message", listener);
						message.type = "error";
						message.error = "timeout";
						reject(message);
						LOG.error(`WARNING (engine) module timeout ${jmodule.name}`);
					}, message.timeout); //safe timeout

					jmodule.on(
						"message",
						(listener = (answer) => {
							if (
								answer.id === message.id &&
								answer.name === message.name &&
								(answer.type === "answer" ||
									answer.type === "error")
							) {
								clearTimeout(timeout);
								jmodule.removeListener("message", listener);
								resolve(JMessage.create(answer));
							}
						})
					);
					
						LOG.debug(
							jmodule.name + " <-\x1b[32mR\x1b[0m-",
							JSON.stringify(message)
						);
					jmodule.sendMessage(message);
				});
			};
			this._modules.push(jmodule);
			//resolve(jsmodule);
		});
	}

	unload(handler) {
		handler.enqueue(new JMessage("jengine.halt"));
		this.unsubscribe(handler);
		return new Promise((resolve) => {
			let _timeout = setTimeout(() => {
				handler.removeAllListeners("exit");
				// handler.removeAllListeners("error");
				handler.kill("SIGKILL");
				LOG.warn(`Unresponsible module ${handler.name} had killed.`);
				resolve();
			}, MESSAGE_TIMEOUT); // wait and kill

			handler.once("exit", () => {
				clearTimeout(_timeout);
				handler.removeAllListeners("exit");
				// handler.removeAllListeners("error");
				LOG.info(`Module ${handler.name} successfully halted.`);
				resolve();
			});
		});
	}

	unsubscribe(handler) {
		if (typeof handler !== "object" || handler === null) return;
		// clear _modules
		for (let i = 0; i < this._modules.length; i++) {
			if (this._modules[i] === handler) {
				delete this._modules[i];
				break;
			}
		}

		// clear _installs
		for (let key of this._installs.keys()) this._uninstall(key, handler);

		// clear _watches
		for (let key of this._watchers.keys()) this._unwatch(key, handler);

		// remove listeners
		handler.removeAllListeners("close");
		handler.removeAllListeners("error");
		handler.removeAllListeners("disconnect");
		handler.removeAllListeners("spawn");
		handler.removeAllListeners("exit");
	}

	_install(name, handler) {
		let handlers = this._installs.get(name);
		if (handlers) {
			for (let i = 0; i < handlers.length; i++) {
				if (handlers[i] == handler) {
					handlers[i] = handler;
					handlers.sort(_getSortHandlers(name));
					return;
				}
			}
			handlers.push(handler);
		} else {
			handlers = [handler];
		}
		handlers.sort(_getSortHandlers(name));
		this._installs.set(name, handlers);
	}

	install(name, handler) {
		if (typeof name !== "string") throw new Error("Wrong message name.");
		if (isModule(handler)) {
			return this._install(name, handler);
		} else if (typeof handler == "function") {
			// make fake module handler
			return this._install(name, {
				name: this.name,
				dispatch: async (m) => handler(m),
			});
		} else {
			throw new Error("Wrong handler.");
		}
	}

	_uninstall(name, handler) {
		let handlers = this._installs.get(name);
		if (handlers) {
			this._installs.set(
				name,
				handlers
					.filter((h) => h !== handler)
					.sort(_getSortHandlers(name))
			);
		}
	}

	uninstall(name, handler) {
		if (typeof name !== "string") throw new Error("Wrong message name.");
		if (isModule(handler)) {
			return this._uninstall(name, handler);
		} else {
			let handlers = this._installs.get(name);
			if (handlers) {
				handler = handlers.find((h) => !h.installs);
				return this._uninstall(name, handler);
			}
		}
	}

	_watch(name, handler) {
		let handlers = this._watchers.get(name);
		if (handlers) {
			for (let i = 0; i < handlers.length; i++) {
				if (handlers[i] == handler) return;
			}
			handlers.push(handler);
		} else {
			handlers = [handler];
		}
		this._watchers.set(name, handlers);
	}

	watch(name, handler) {
		if (typeof name !== "string") throw new Error("Wrong message name.");
		if (isModule(handler)) {
			return this._watch(name, handler);
		} else if (typeof handler == "function") {
			return this._watch(name, {
				name: this.name,
				enqueue: async (m) => handler(m),
			});
		} else {
			throw new Error("Wrong handler.");
		}
	}

	_unwatch(name, handler) {
		let handlers = this._watchers.get(name);
		if (handlers) {
			this._watchers.set(
				name,
				handlers.filter((h) => h !== handler)
			);
		}
	}

	// _enqueue(message, exclude) {
	// 	let handlers = this._installs.get(message.name);
	// 	if (handlers && handlers.length > 0) {
	// 		for (let i = 0; i < handlers.length; i++) {
	// 			if (handlers[i] == exclude) continue;
	// 			handlers[i].enqueue(message);
	// 		}
	// 	}
	// 	return Promise.resolve(message);
	// }

	_notify(message, exclude) {
		message.type = "answer";
		let handlers = this._watchers.get(message.name);
		if (handlers && handlers.length > 0) {
			for (let i = 0; i < handlers.length; i++) {
				if (handlers[i] == exclude && !exclude.selfwatch) continue;
				handlers[i].enqueue(message);
			}
		}
		return Promise.resolve(message);
	}

	_dispatch(message, exclude) {
		if (message.handled) return Promise.resolve(message);
		let handlers = this._installs.get(message.name);
		if (handlers && handlers.length > 0) {
			// Dispatch the message by handlers in the piority order until the message is not handled
			let task;
			let asked = [];
			if (typeof message.timeout !== "number")
				message.timeout = MESSAGE_TIMEOUT;
			let started = Date.now();
			for (let i = 0; i < handlers.length; i++) {
				if (handlers[i] == exclude && !exclude.selfdispatch) {
					//console.log("Skip handler", exclude.name, exclude.selfdispatch);
					continue;
				}
				asked.push(handlers[i].name);
				if (i > 0 && task) {
					task = task.then((answer) => {
						answer.timeout -= Date.now() - started;
						answer.type = "request";
						answer.handlers = asked;
						if (!answer.handled && answer.timeout > 0) {
							return handlers[i].dispatch(answer);
						} else {
							return Promise.resolve(answer);
						}
					});
				} else {
					message.handlers = asked;
					task = handlers[i].dispatch(message);
				}
			}
			return task ? task : Promise.resolve(message);
		}
		return Promise.resolve(message);
	}
}

// Handler side
function connect(options) {
    if (JENGINE) { return JENGINE }

	// !!! remove for production
	//process.once("SIGTERM", () => {});
	//process.once("SIGINT", () => {});
	process.setMaxListeners(200);

	process.on("error", err => {
		console.log("Module error", err.stack);
		process.exit(1);
	});

    // Handle messages from JEngine
    process.on("message", message => {
        if (!JMessage.isMessage(message)) {
			console.log("WARNING (module) Unknown message", message);
			return;
		}
        message = JMessage.create(message);
        switch(message.type) {
            case "request":
				JENGINE._handle(message)
				.then(answer => {
					// Check the handler result
					if (!JMessage.isMessage(answer)) {
						if (typeof answer !== "undefined" && answer !== null) {
							message.result = typeof answer === "object" ? { ...answer } : answer;
							message.handled = true;
						}
						message.type = "answer";
						process.send(message);
					} else {
						answer.id = message.id;
						answer.name = message.name;
						answer.type = answer.type !== "error" ? "answer" : "error";
						process.send(answer);
					}
                });
                break;
            case "error":
            case "answer":
                JENGINE._notify(message);
                break;
            default:
                // do nothing
        }
    });

    JENGINE = {
		_installs: new Map(),
		_watches: new Map(),

		_handle: function (message) {
			let handler = JENGINE._installs.get(message.name);
			if (typeof handler !== "function") {
				return Promise.resolve(message);
			}
			return new Promise((resolve, reject) => {
				const dispatch_timeout =
					typeof message.timeout == "number"
						? message.timeout
						: MESSAGE_TIMEOUT;

				let timeout = setTimeout(() => {
					message.error = "Message handler timeout.";
					reject(message);
					console.log(
						"WARNING (module) handler timeout.",
						message.name,
						message.id
					);
				}, dispatch_timeout - MESSAGE_DELAY);

				return Promise.resolve(handler(message)).then((answer) => {
					clearTimeout(timeout);
					resolve(answer);
				});

			}).catch((err) => {
				message.type = "error";
				message.error = err.error;
				console.log(
					"ERROR (module) handler error.",
					message.name,
					message.id,
					err
				);
				return message;
			});
		},

		_notify: function (message) {
			let handler = JENGINE._watches.get(message.name);
			if (typeof handler == "function") {
				handler(message);
			}
			return Promise.resolve(message);
		},

		install: function (name, handler, priority) {
			if (typeof priority !== "number") priority = 100;
			JENGINE._installs.set(name, handler);
			process.send(
				JMessage.create({ type: "install", name: name, priority: priority })
			);
		},

		uninstall: function (name) {
			JENGINE._installs.delete(name);
			process.send(
				JMessage.create({ type: "uninstall", name: name })
			);
		},

		watch: function (name, handler) {
			JENGINE._watches.set(name, handler);
			process.send(
				JMessage.create({ type: "watch", name: name })
			);
		},

		unwatch: function (name) {
			JENGINE._watches.delete(name);
			process.send(
				JMessage.create({ type: "unwatch", name: name })
			);
		},

		enqueue: function (name, options) {
			let message;
			if (JMessage.isMessage(name)) message = name;
			else if (typeof name == "string" && name !== "") message = new JMessage(name, options);
			else if (typeof name == "object") message = JMessage.create(name);
			else return Promise.reject(new Error("Wrong message."));

			message.type = "request";
			message.enqueue = true;
			process.send(message);
			return Promise.resolve(message);
		},

		dispatch: function (name, options) {
			let message;
			if (JMessage.isMessage(name)) message = name;
			else if (typeof name == "string" && name !== "") message = new JMessage(name, options);
			else if (typeof name == "object") message = JMessage.create(name);
			else return Promise.reject(new Error("Wrong message."));

			return new Promise((resolve, reject) => {
				let listener;
				const dispatch_timeout =
					typeof message.timeout == "number"
						? message.timeout
						: MESSAGE_TIMEOUT;

				let timeout = setTimeout(() => {
					process.removeListener("message", listener);
					message.type = "error";
					message.error = "timeout";
					reject(message);
					console.log(
						"ERROR (module) dispatch timeout",
						message._name,
						message._id
					);
				}, dispatch_timeout + 10);

				process.on(
					"message",
					listener = (answer) => {
						if (
							answer.id === message.id &&
							(answer.type === "answer" || answer.type === "error")
						) {
							clearTimeout(timeout);
							process.removeListener("message", listener);
							if (answer.type === "error") {
								console.log(
									"ERROR (module) dispatch",
									answer.name,
									answer.id
								);
								reject(JMessage.create(answer));
							} else {
								resolve(JMessage.create(answer));
							}
						}
					}
				);

				message.type = "request";
				message.enqueue = false;
				process.send(message);
			});
		},

		setlocal: function(params) {
			if (typeof params !== "object") return Promise.reject(params);
			return new Promise((resolve, reject) => {
				let listener;

				let timeout = setTimeout(() => {
					process.removeListener("message", listener);
					reject(params);
					console.log("ERROR (module) setlocal timeout", params );
				}, MESSAGE_TIMEOUT);

				const message = JMessage.create({type: "setlocal", name: "setlocal", ...params});
				process.on(
					"message",
					listener = (answer) => {
						if (
							answer.id === message.id &&
							(answer.type === "setlocal" || answer.type === "error")
						) {
							clearTimeout(timeout);
							process.removeListener("message", listener);
							if (answer.type === "error") {
								console.log(
									"ERROR (module) setlocal",
									answer.name,
									answer.id
								);
								reject(JMessage.create(answer));
							} else {
								//if (params.trackname)
								resolve(JMessage.create(answer));
							}
						}
					}
				);
				process.send(message);
			});
		}
	};

	// Resolves parent loadModule promise
	process.send(JMessage.create({type: "connect", name: "connect"}));

	if(typeof options === "object") {
		JENGINE.setlocal(options);
	}
	if(typeof options === "string" && options.length > 0) {
		JENGINE.setlocal({trackname: options});
	}

    return JENGINE;
}

function isModule(handler) {
	return (handler instanceof ChildProcess);
}

function _getSortHandlers(name) {
    return function(a, b) {
		if (!a || !b || !a.installs || !b.installs) return 0
        if (a.installs[name] > b.installs[name]) return 1;
        if (a.installs[name] == b.installs[name]) return 0;
        if (a.installs[name] < b.installs[name]) return -1;
    }
}

module.exports = { JMessage, JEngine, connect }