// Launch the local Electron binary with a clean environment.
// Some hosts (for example editor extension processes) export ELECTRON_RUN_AS_NODE=1,
// which makes Electron behave as plain Node and breaks `require('electron')`.
import electron from 'electron';
import { spawn } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env, windowsHide: false });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
