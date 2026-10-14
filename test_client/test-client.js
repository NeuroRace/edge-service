const io = require('socket.io-client');

const BROKER = process.env.BROKER_URL || 'http://broker:3000';

// NEU-139: se apresenta, senao o broker o contaria como o jogo (conexao anonima).
const socket = io(BROKER, { auth: { role: 'test-client' } });

socket.on('connect', () => console.log('Cliente teste conectado', socket.id));
socket.on('disconnect', () => console.log('Cliente teste desconectado'));
socket.on('connect_error', (err) => console.error('Erro de conexão:', err.message));

socket.on('eSense', (data) => console.log('eSense:', data));
socket.on('blink', (data) => console.log('blink:', data));
socket.on('handGesture', (data) => console.log('handGesture:', data));



