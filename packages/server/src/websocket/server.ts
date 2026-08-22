import { WebSocketServer } from 'ws';
import { handleConnection } from './connectionHandler.js';

export function createSignalingServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });
  wss.on('connection', handleConnection);
  return wss;
}
