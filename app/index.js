const { readFile, writeFile } = require('fs');
const { connect, createServer } = require('net');
const EventEmitter = require('events');
const { promisify } = require('util');
const { getCurrentWindow, dialog } = require('electron').remote;
const DMP = require('diff-match-patch');

const { defaultValue, stepOne, stepServerTwo, stepServerThree, stepClientTwo, stepClientThree } = require('./strings.js');

// Setup code mirror

CodeMirror.commands.save = save;
CodeMirror.commands.open = open;

const m = CodeMirror(document.body, {
	theme: 'tomorrow-night-eighties',
	keyMap: 'sublime',
	autofocus: true,
	lineNumbers: true,
	tabSize: 2,
	indentUnit: 2,
	indentWithTabs: true,
	extraKeys: {
		'Cmd-O': 'open',
		'Ctrl-O': 'open',
		'Cmd-S': 'save',
		'Ctrl-S': 'save',
	},
 	value: defaultValue + stepOne,
});

m.on('change', change);

// Simple APIs

function setTitle(t) {
	console.log(t);
	document.querySelector('.title').innerText = t;
}

let filename = '';

async function loadFile(f) {
	const contents = await promisify(readFile)(f, { encoding: 'utf8' });
	filename = f;
	m.setValue(contents);
}

async function save(e) {
	if (filename.length > 0) {
		setTitle('saving');
		await promisify(writeFile)(filename, m.getValue(), { encoding: 'utf8' });
		setTitle('saved');
		setTimeout(() => setTitle(filename), 1000);
	}
};

async function open(e) {
	if (mode === 'client' && !connected) {
		return await attemptConnect();
	}
	if (mode === 'server' && !listening) {
		await attemptListen();
	}
	setTitle('opening');
	dialog.showOpenDialog(getCurrentWindow(), {
		properties: ['openFile'],
	}, async (f) => {
		await loadFile(f[0]);
		setTitle(f[0]);
	});
};

// editor changes

let oldValue = '';

async function change(e) {
	if (!connected && !listening) {
		await validate();
	} else {
		const newValue = m.getValue();
		// send new for now
		const delta = dmp.patch_make(oldValue, newValue);
		if (oldValue === newValue) {
			return;
		}
		oldValue = newValue;
		await sendDelta(delta);
	}
};

const dmp = new DMP();

async function getFirstDelta() {
	return dmp.patch_make('', m.getValue());
}

async function applyDelta(delta) {
	const cursor = m.getCursor();
	oldValue = dmp.patch_apply(delta, m.getValue())[0]
	m.setValue(oldValue);
	m.setCursor(cursor);
}

// config parser

let mode = '';
let addr = '';

async function validate() {
	const value = m.getValue();
	const matches = value.match(/\d\..*:.*$/gm);
	const values = matches.map(m => m.split(/: /).pop().trim() || '');
	
	// Parse for inputs
	
	// mode
	if (values[0] !== mode) {
		if (values[0] === 'client' || values[0] === 'server') {
			mode = values[0];
			const cursor = m.getCursor();
			m.setValue(
				defaultValue
				+ stepOne
				+ mode
				+ (mode === 'client' ? stepClientTwo : stepServerTwo)
			);
			m.setCursor(cursor);
		}
	}

	// addr
	if (values[1] && values[1] !== addr && mode !== '') {
		if (validAddr(values[1])) {
			addr = values[1];
			const cursor = m.getCursor();
			m.setValue(
				defaultValue
				+ stepOne
				+ mode
				+ (mode === 'client' ? stepClientTwo : stepServerTwo)
				+ addr
				+ (mode === 'client' ? stepClientThree : stepServerThree)
			);
			m.setCursor(cursor);
		}
	}

	return values;
}

async function validAddr(addr) {
	if (typeof addr !== 'string') {
		return false;
	}
	const parts = addr.split(/:/);
	if (parts.length != 2) {
		return false;
	}
	const port = parseInt(parts[1]);
	return 1 <= port && port <= 65535;
}

// Socket APIs

class Parser extends EventEmitter {

	constructor(readable) {
		super();

		this.state = 'header';
		this.header = {};
		this.buf = Buffer.from([]);

		readable.on('data', (chunk) => {
			this.process(chunk);
		});
	}

	process(chunk) {
		this.buf = Buffer.concat([this.buf, chunk]);

		if (this.state === 'header') {
			const until = chunk.indexOf('\n\n');
			if (until > -1) {
				console.log('header');
				this.header = this.parseHeader(this.buf.slice(0, until));
				this.buf = this.buf.slice(until + 2);
				this.state = 'body';
			}
		}
		if (this.state === 'body') {
			const contentLength = parseInt(this.header['Content-Length']);
			if (this.buf.length >= contentLength) {
				console.log('body', contentLength, this.buf);
				this.readContent(this.buf.slice(0, contentLength));
				this.buf = this.buf.slice(contentLength);
				this.state = 'header';
			}
		}
	}

	parseHeader(buf) {
		return buf
			.toString()
			.split(/\n/)
			.map(l => l.split(':'))
			.map(l => [l[0], l.slice(1).join(':')])
			.filter(l => l[0].length > 0)
			.reduce((a, l) => ({
				...a,
				[l[0]]: l[1],
			}), {});
	}

	readContent(buf) {
		this.emit('message', {
			header: this.header,
			body: JSON.parse(buf.toString()),
		});
		this.emit('delta', JSON.parse(buf.toString()));
	}

}

function serialize(delta) {
	const json = JSON.stringify(delta);
	return 'Content-Length: ' + Buffer.from(json).length + '\n\n' + json;
}

// client

let connected = false;
let connection = null;
async function attemptConnect() {
	setTitle('connecting');
    const parts = addr.split(/:/);

	// connect performs a connection to a host + port
	connection = connect(parseInt(parts[1]), parts[0]);

	connection.on('connect', () => {
		connected = true;
		setTitle('connected');
		m.setValue('');
	});
	connection.on('error', () => {
		setTitle('connection error!');
	});

	// set up a parser to read incoming deltas
	const parser = new Parser(connection);
	parser.on('delta', m => {
		// apply delta to editor
		applyDelta(m);
	});
}

async function sendDelta(delta) {
	if (mode === 'server') {
		// send directly to server broadcast thing
		return await broadcastDelta(delta);
	}
	// send delta to server
	connection.write(serialize(delta));
}

// server

let listening = false;
let server = null;
let connections = [];
function attemptListen() {
	return new Promise((resolve, reject) => {
		setTitle('setting up server');

		// createServer() opens a TCP port to accept incoming connections
		server = createServer();
		connections = [];

		server.on('connection', async (c) => {
			setTitle('new client connected');
			setTimeout(() => setTitle(filename), 1000);

			// maintain a list of clients to do broadcasting later
			connections.push(c);
			// send the first update
			c.write(serialize(await getFirstDelta()));

			// setup incoming parser for deltas
			const parser = new Parser(c);
			parser.on('delta', async m => {
				// apply delta to editor
				applyDelta(m);
				broadcastDelta(m, c);
			});
			
		});
		server.on('error', (e) => {
			setTitle('can\'t start server, ' + e.code);
			reject();
		});
		//server.on('listening', () => {
			listening = true;
			setTitle('server ready');
		//	resolve();
		//});
		server.listen(parseInt(addr));
		resolve();
	});
}

async function broadcastDelta(delta, omit) {
	await Promise.all(
		// for every connection that != omit, write data to the socket
		connections
			.filter(c => c !== omit)
			.map(async c => {
				try {
					c.write(serialize(delta));
				} catch (e) {
				}
			})
	);
}
