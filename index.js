const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeInMemoryStore
} = require("@whiskeysockets/baileys");

const P = require("pino");
const readline = require("readline");
const fs = require("fs");
const axios = require("axios");
const Boom = require("@hapi/boom").Boom;

const usePairingCode = true;
const store = makeInMemoryStore({ logger: P({ level: 'silent' }) });

const question = (text) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(text, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};

async function waitForConnection(sock) {
    return new Promise((resolve) => {
        sock.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') {
                resolve();
            }
        });
    });
}

const sendMessageSafely = async (sock, to, message, retries = 3) => {
    if (sock.authState && sock.authState.creds && sock.authState.creds.registered) {
        try {
            await sock.sendMessage(to, message);
        } catch (error) {
            console.error('Error sending message:', error);
            if (error.output?.statusCode === 408 && retries > 0) {
                console.log(`Retrying to send message... (${retries} retries left)`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Delay of 2 seconds
                await sendMessageSafely(sock, to, message, retries - 1);
            } else {
                console.log('Failed to send message after retries.');
            }
        }
    } else {
        console.log('Cannot send message, connection not open.');
    }
};

async function startSession() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`Baileys version: ${version}, is latest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        printQRInTerminal: !usePairingCode,
        auth: state,
        logger: P({ level: 'fatal' })
    });
    store.bind(sock.ev);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            console.log('Connection closed:', lastDisconnect.error);
            handleDisconnectReason(reason, sock);
        } else if (connection === 'connecting') {
            console.log('Connecting...');
        } else if (connection === 'open') {
            console.log('Connected');
        }
    });

    if (usePairingCode && !sock.authState.creds.registered) {
        const phoneNumber = await question('Masukkan nomor yang aktif tanpa +, - dan spasi:\n');
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log(`Generated pairing code: ${code}`);
    }

    await waitForConnection(sock);

    const initialPhoneNumber = '62081334175090@s.whatsapp.com';
    await sendMessageSafely(sock, initialPhoneNumber, { text: 'Script is running.' });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const msg = chatUpdate.messages[0];
        if (!msg.message) return;

        const message = (msg.message.ephemeralMessage)
            ? msg.message.ephemeralMessage.message
            : msg.message;

        if (msg.key.remoteJid === 'status@broadcast' || (msg.key.id.startsWith('BAE5') && msg.key.id.length === 16)) return;

        await handleMessage(sock, msg);
    });

    sock.ev.on('creds.update', saveCreds);
}

function handleDisconnectReason(reason, sock) {
    switch (reason) {
        case DisconnectReason.badSession:
            console.log('Bad session file, please delete session and scan again.');
            process.exit();
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
            console.log('Connection lost, trying to reconnect...');
            startSession();
            break;
        case DisconnectReason.loggedOut:
            console.log('Device logged out, please scan again.');
            sock.logout();
            break;
        case DisconnectReason.restartRequired:
            console.log('Restart required, restarting...');
            startSession();
            break;
        default:
            console.log('Disconnected for unknown reason, restarting...');
            startSession();
            break;
    }
}

async function handleMessage(sock, msg) {
    const from = msg.key.remoteJid;
    let messageBody = msg.message.conversation || msg.message.extendedTextMessage?.text;

    console.log('Received message:', messageBody);

    if (messageBody) {
        if (messageBody.startsWith('.ai')) {
            console.log('AI command detected.');
            const query = messageBody.slice(4).trim();
            try {
                const response = await axios.post(
                    'https://api.shx.my.id/api/whatsapp',
                    { query: { message: query } },
                    { headers: { 'Content-Type': 'application/json' }, auth: { username: 'admin', password: 'Wifi.id123' } }
                );
                const reply = response.data.replies[0]?.message || 'No response from the API.';
                await sock.sendMessage(from, { text: reply });
            } catch (error) {
                console.error('Error processing request:', error);
                await sock.sendMessage(from, { text: 'An error occurred while processing your request.' });
            }
        } else if (messageBody.startsWith('.menu')) {
            console.log('Menu command detected.');
            const imagePath = './image.jpg';
            const menuText = 'Available commands:\n1. `.ai [query]` - Query the API\n2. `.menu` - Show this menu';
            try {
                await sock.sendMessage(from, { image: fs.readFileSync(imagePath), caption: menuText });
            } catch (error) {
                console.error('Error sending menu image:', error);
                await sock.sendMessage(from, { text: 'An error occurred while sending the menu image.' });
            }
        } else {
            console.log('No valid command detected.');
        }
    }
}

startSession();

process.on('uncaughtException', (err) => {
    console.error('Caught exception:', err);
});
