const WebSocket = require('ws');
const net = require('net');

const WS_URL = 'ws://152.53.114.112:8090';
const WS_AUTH = 'chisel:iWiwcVhgUQtIo5JPBX5dqmmU';

// Connect to Chisel server via WebSocket
const ws = new WebSocket(WS_URL, {
  headers: {
    Authorization: 'Basic ' + Buffer.from(WS_AUTH).toString('base64'),
  }
});

ws.on('open', function() {
  console.log('WebSocket connected');
  // Send auth message
  ws.send(JSON.stringify({
    type: 'auth',
    payload: WS_AUTH
  }));
});

ws.on('message', function(data) {
  console.log('Message:', data.toString());
});

ws.on('error', function(err) {
  console.error('Error:', err.message);
});

ws.on('close', function(code, reason) {
  console.log('Closed:', code, reason.toString());
});

// Timeout
setTimeout(function() {
  console.log('Timeout, closing');
  ws.close();
}, 10000);
