import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

console.error('DEBUG: about to create transport');
const transport = new StdioServerTransport();
console.error('DEBUG: transport created');

const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });
console.error('DEBUG: server created');

try {
  await server.connect(transport);
  console.error('DEBUG: connected');
} catch(e) {
  console.error('DEBUG: connect error:', e.message);
}

// read stdin and respond
const input = readFileSync('/dev/stdin', 'utf8');
const lines = input.trim().split('\n').filter(Boolean);
console.error('DEBUG: received', lines.length, 'messages');

if (lines.length > 0) {
  const msg = JSON.parse(lines[0]);
  console.log(JSON.stringify({jsonrpc:'2.0', id: msg.id, result: {success: true}}));
}
