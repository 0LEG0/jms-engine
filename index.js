"use strict";

const crypto = require("crypto");
const path = require("path");
const { fork, ChildProcess } = require("child_process");

/* defaults */
let MESSAGE_TIMEOUT = 3000; // default timeout dispatch: 3s
let MESSAGE_DELAY = 20;
let JENGINE = null;

/* logger */
class Logger {
	constructor(level = 3) {
		this.level = level;
	}
	setLevel(l) {
		if (typeof l == "string" && typeof Logger[l] == "number" && Logger[l] >= 0 && Logger[l] <= 3) this.level = Logger[l];
		if (typeof l == "number" && l >= 0 && l <= 3) this.level = l;
	}
	getLevel() { return this.level }
	log(level, ...args) {
		if (typeof level == "string") level = Logger[level];
		if (level <= this.level) this._write(level, ...args);
	}
	error(...args) { this.log(Logger.ERROR, ...args) }
	warn(...args) { this.log(Logger.WARN, ...args) }
	info(...args) { this.log(Logger.INFO, ...args) }
	debug(...args) { this.log(Logger.DEBUG, ...args) }
	_write(level, ...args) {
		//                                                        blue                      green                     purple       red
		console.log(`${new Date().toISOString()} [${level > 2 ? "\x1b[36m" : (level > 1 ? "\x1b[32m" : (level > 0 ? "\x1b[35m" : "\x1b[31m"))}${Logger[level]}\x1b[0m]`, ...args);
	}
}
Logger.ERROR = 0; Logger[0] = "ERROR";
Logger.WARN = 1; Logger[1] = "WARN";
Logger.INFO = 2; Logger[2] = "INFO";
Logger.DEBUG = 3; Logger[3] = "DEBUG";

/* Message */
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
		this.timeout = typeof timeout == "number" ? timeout : undefined;
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

/* Engine */
class JEngine extends Logger {

	constructor(name) {
		super();
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
	// Set global message timeout
	setTimeout(timeout) {
		if (typeof timeout == "number") return MESSAGE_TIMEOUT = timeout;
		return MESSAGE_TIMEOUT;
	}

	load(...args) {
		return new Promise((resolve, reject) => {
			let jengine = this;
			const jmodule = fork(...args); //, {stdio: ['ipc', 'ignore', 'ignore']});
			jmodule.name = path.basename(jmodule.spawnargs[1], ".js");
			jmodule.ready = false;
			jmodule.respawn = true;
			jmodule.selfwatch = false;
			jmodule.selfdispatch = false;
			jmodule.selftimeout = MESSAGE_TIMEOUT;
			jmodule.installs = {};
			jmodule.setMaxListeners(200);

			jmodule.sendMessage = function (...args) {
				try {
					if (jmodule.connected && jmodule.channel)
						jmodule.send(...args);
				} catch (err) {
					jengine.error(`Module ${jmodule.name} IPC error`, err.stack);
				}
			};

			jmodule.on("close", (ev) => {
				jengine.info(`Module ${jmodule.name} closed with code: ${ev}`);
			});

			jmodule.on("error", (err) => {
				jengine.error(`Module ${jmodule.name} internal error occur`, err.stack);
			});

			jmodule.on("disconnect", () => {
				jengine.warn(`Module ${jmodule.name} has been disconnected.`);
				// Reject if not initialized
				if (!jmodule.ready) {
					reject(`Module ${jmodule.name} loading failed.`);
				}
			});
			jmodule.on("spawn", () => {
				jengine.info(`Module ${jmodule.name} loading...`);
			});

			// respawn
			jmodule.once("exit", (ev) => {
				jengine.info(`Module ${jmodule.name} exited with code ${ev}`);
				jengine.unsubscribe(jmodule, ev);
				if (ev !== 0 && jmodule.respawn && jmodule.ready)
					setTimeout(() => {
						jengine.info("Try respawn", jmodule.name);
						jengine.load(...args);
					}, 7000);
			});

			// Setup handler
			jmodule.on("message", (message) => {
				// Resolve load() with any incoming message!
				if (!jmodule.ready) {
					jengine.info(`Module ${jmodule.name} is ready.`);
					jmodule.ready = true;
					resolve(jmodule);
				}
				// Skip if not message
				if (!JMessage.isMessage(message)) {
					jengine.debug(`${jmodule.name} -\x1b[31m?\x1b[0m-> ${JSON.stringify(message)}`);
					return;
				}
				message = JMessage.create(message);
				// Define message.timeout
				if (typeof message.timeout !== "number") message.timeout = jmodule.selftimeout || MESSAGE_TIMEOUT;

				switch (message.type) {
					case "request":
						if (message.enqueue) {
							jengine.debug(`${jmodule.name} -\x1b[31mE\x1b[0m-> ${JSON.stringify(message)}`);
						} else {
							jengine.debug(`${jmodule.name} -\x1b[31mR\x1b[0m-> ${JSON.stringify(message)}`);
						}
						jengine._dispatch(message, jmodule)
							.catch((err) => {
								message.error = err.stack;
								message.type = "error";
								return message;
							})
							.then((answer) => {
								//result = SMessage.create(result);
								answer.type = (answer.type !== "error") ? "answer" : "error";
								answer.handled = answer.handled ? true : false;
								if (!message.enqueue) {
									jengine.debug(`${jmodule.name} <-\x1b[31mA\x1b[0m- ${JSON.stringify(answer)}`);
									if (jmodule.connected) jmodule.sendMessage(answer);
								}
								return answer;
							})
							.then((notice) => jengine._notify(notice, jmodule));
						break;
					case "install":
						jengine.debug(`${jmodule.name} -I-> ${JSON.stringify(message)}`);
						jmodule.installs[message.name] = message.payload.priority;
						jengine._install(message.name, jmodule);
						break;
					case "uninstall":
						jengine.debug(`${jmodule.name} -U-> ${JSON.stringify(message)}`);
						jengine._uninstall(message.name, jmodule);
						break;
					case "watch":
						jengine.debug(`${jmodule.name} -W-> ${JSON.stringify(message)}`);
						jengine._watch(message.name, jmodule);
						break;
					case "unwatch":
						jengine.debug(`${jmodule.name} -U-> ${JSON.stringify(message)}`);
						jengine._unwatch(message.name, jmodule);
						break;
					case "setlocal":
						jengine.debug(`${jmodule.name} -S-> ${JSON.stringify(message)}`);
						jmodule.setlocal(message);
						break;
					case "connect":
						jengine.debug(`${jmodule.name} -C-> ${JSON.stringify(message)}`);
						if (!jmodule.ready) {
							jengine.info(`Module ${jmodule.name} has been connected.`);
							jmodule.ready = true;
							resolve(jmodule);
						}
						break;
					case "log":
						jengine.log(message.get("level"), ...message.get("text"));
						break;
					default:
						// reply
						jengine.debug(`${jmodule.name} -\x1b[32mA\x1b[0m-> ${JSON.stringify(message)}`);
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
						case "selftimeout":
							if (typeof message.payload[key] === "number") {
								jmodule.selftimeout = message.payload[key];
							}
							message.result[key] = jmodule.selftimeout;
							break;
						case "jengine.configpath":
							// readonly configpath
							break;
						case "jengine.modulepath":
							// readonly modulepath
					}
				}
				jengine.debug(`${jmodule.name} <-S- ${JSON.stringify(message)}`);
				jmodule.sendMessage(message);
			};

			jmodule.enqueue = function (message) {
				jengine.debug(`${jmodule.name} <-\x1b[36mN\x1b[0m- ${JSON.stringify(message)}`);
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
						jengine.warn(`WARNING (engine) module timeout ${jmodule.name}`);
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
					jengine.debug(`${jmodule.name} <-\x1b[32mR\x1b[0m- ${JSON.stringify(message)}`);
					jmodule.sendMessage(message);
				});
			};
			jengine._modules.push(jmodule);
			//resolve(jsmodule);
		});
	}

	_unload(handler) {
		handler.enqueue(new JMessage("jengine.halt"));
		this.unsubscribe(handler);
		return new Promise((resolve) => {
			let _timeout = setTimeout(() => {
				handler.removeAllListeners("exit");
				// handler.removeAllListeners("error");
				handler.kill("SIGKILL");
				this.warn(`Unresponsible module ${handler.name} had killed.`);
				resolve(`Unresponsible module ${handler.name} had killed.`);
			}, MESSAGE_TIMEOUT); // wait and kill

			handler.once("exit", () => {
				clearTimeout(_timeout);
				handler.removeAllListeners("exit");
				// handler.removeAllListeners("error");
				this.info(`Module ${handler.name} successfully halted.`);
				resolve(`Module ${handler.name} successfully halted.`);
			});
		});
	}
	unload(handler) {
		if (isModule(handler)) {
			return this._unload(handler);
		} else if (typeof handler == "string") {
			handler = this._modules.find(i => (i && i.name === handler));
			if (handler) return this._unload(handler);
		}
		return Promise.reject("Wrong module.");
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
				dispatch: async (m) => handler(m)
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
			if (typeof message.timeout !== "number") message.timeout = MESSAGE_TIMEOUT; //safe timeout
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

/* Connect to Engine */
function connect(options) {
    if (JENGINE) { return JENGINE }

	// !!! remove for production
	// process.once("SIGTERM", () => {});
	// process.once("SIGINT", () => {});
	process.setMaxListeners(200);

	process.on("error", err => {
		console.log("Module error", err.stack);
		process.exit(1);
	});

    // Handle messages from JEngine
    process.on("message", message => {
        if (!JMessage.isMessage(message)) {
			JENGINE.warn("WARNING (module) Unknown message", message);
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

		_handle: function(message) {
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
					JENGINE.warn("WARNING (module) handler timeout.", message.name,	message.id);
				}, dispatch_timeout - MESSAGE_DELAY);

				return Promise.resolve(handler(message)).then((answer) => {
					clearTimeout(timeout);
					resolve(answer);
				});

			}).catch((err) => {
				message.type = "error";
				message.error = err.error;
				JENGINE.error("ERROR (module) handler error.", message.name, message.id, err);
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
			process.send(JMessage.create({ type: "install", name: name, priority: priority }));
		},

		uninstall: function (name) {
			JENGINE._installs.delete(name);
			process.send(JMessage.create({ type: "uninstall", name: name }));
		},

		watch: function (name, handler) {
			JENGINE._watches.set(name, handler);
			process.send(JMessage.create({ type: "watch", name: name }));
		},

		unwatch: function (name) {
			JENGINE._watches.delete(name);
			process.send(JMessage.create({ type: "unwatch", name: name }));
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
						: (JENGINE.selftimeout || MESSAGE_TIMEOUT);

				let timeout = setTimeout(() => {
					process.removeListener("message", listener);
					message.type = "error";
					message.error = "timeout";
					reject(message);
					JENGINE.error("ERROR (module) dispatch timeout", message.name,	message.id);
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

		setlocal: function(params, value) {
			if (!(typeof params == "object" || typeof params == "string")) return Promise.reject(params);
			return new Promise((resolve, reject) => {
				let listener;

				let timeout = setTimeout(() => {
					process.removeListener("message", listener);
					reject(params);
					JENGINE.error("ERROR (module) setlocal timeout", params );
				}, JENGINE.selftimeout || MESSAGE_TIMEOUT);

				params = typeof params == "string" ? { [params]: (typeof value == "number" || typeof value == "boolean" || typeof value == "string") ? value : null } : params;
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
								reject(answer.error);
							} else {
								resolve(answer.result);
								// Dangerous!!! can break JENGINE
								for (let key in answer.payload) {
									if (/^(respawn|selfwatch|selfdispatch|selftimeout)$/.test(key)) JENGINE[key] = answer.payload[key];
								}
							}
						}
					}
				);
				process.send(message);
			});
		}
	};

	let LOG = new Logger();
	// replace LOG writer with message sender
	LOG._write = (level, ...args) => {
		process.send(JMessage.create({type: "log", name: "log", level: level, text: args}));
	};

	Object.setPrototypeOf(JENGINE, LOG);

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