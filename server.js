/**
 * B&L info service - Hotspot v4 Backend
 * Node.js + Express + RouterOS API + Telegram Bot + Gemini AI
 * Deploy sur Render.com
 *
 * Architecture (MikroTik Pull Sync):
 *   Client --> Hotspot Pages --> Render Backend (HTTPS)
 *                                    |
 *   Android SMS Forwarder --> Telegram Bot --> Webhook --> Render Backend
 *                                    |                        |
 *   Gemini AI (optional) --> Auto-validate payment SMS       |
 *                                    |                        |
 *   MikroTik <-- /api/sync/pending -- Render Backend (file d'attente)
 *   MikroTik --> /api/sync/confirm --> Render Backend (confirmation)
 *
 *   Le MikroTik tire les utilisateurs du backend (pull)
 *   au lieu que le backend pousse vers le MikroTik (impossible depuis le cloud)
 */

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { RouterOSAPI } = require('node-routeros');

const app = express();

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // MikroTik Router
    ROUTER_HOST: process.env.MIKROTIK_HOST || process.env.ROUTER_HOST || '192.168.88.1',
    ROUTER_USER: process.env.MIKROTIK_USER || process.env.ROUTER_USER || 'admin',
    ROUTER_PASS: process.env.MIKROTIK_PASSWORD || process.env.ROUTER_PASS || '',
    ROUTER_PORT: parseInt(process.env.MIKROTIK_PORT || process.env.ROUTER_PORT || '8728'),

    // Server
    PORT: parseInt(process.env.PORT || '3000'),

    // JWT
    JWT_SECRET: process.env.JWT_SECRET || 'bl-hotspot-jwt-secret-change-me-in-production',
    JWT_EXPIRES: '24h',

    // Admin credentials
    ADMIN_USER: process.env.ADMIN_USER || 'admin',
    ADMIN_PASS: process.env.ADMIN_PASS || '',

    // Mobile Money recipients (phone numbers to send payment to)
    MM_ORANGE_RECIPIENT: process.env.MM_ORANGE_RECIPIENT || '0320000000',
    MM_MVOLA_RECIPIENT: process.env.MM_MVOLA_RECIPIENT || '0340000000',
    MM_AIRTEL_RECIPIENT: process.env.MM_AIRTEL_RECIPIENT || '0330000000',

    // Telegram Bot
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

    // Gemini AI (optional auto-validation)
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    AUTO_VALIDATE: process.env.AUTO_VALIDATE === 'true' || false,

    // Hotspot interface
    HOTSPOT_INTERFACE: 'bridge-hotspot',

    // Sync Token (pour que le MikroTik s'authentifie au backend)
    SYNC_TOKEN: process.env.SYNC_TOKEN || 'bl-hotspot-sync-change-me'
};

// ============================================
// FILE-BASED PERSISTENCE (Render restart resilience)
// ============================================
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_FILE = path.join(DATA_DIR, 'hotspot-data.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Save state to file (for Render restart resilience)
function saveStateToFile() {
    try {
        const state = {
            paymentsDB: {
                pending: Array.from(paymentsDB.pending.entries()),
                smsReceived: Array.from(paymentsDB.smsReceived.entries()),
                verified: Array.from(paymentsDB.verified.entries()),
                approved: Array.from(paymentsDB.approved.entries()),
                notifications: paymentsDB.notifications.slice(-100)
            },
            appearanceDB: appearanceDB.settings,
            syncQueue: syncQueue.items,
            syncConfirmed: syncQueue.confirmed,
            adminCredentials: {
                user: CONFIG.ADMIN_USER,
                pass: CONFIG.ADMIN_PASS
            },
            lastSaved: new Date().toISOString()
        };
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(state), 'utf8');
        console.log('[Backup] Etat sauvegarde dans', BACKUP_FILE);
    } catch (err) {
        console.error('[Backup] Erreur sauvegarde:', err.message);
    }
}

// Load state from file
function loadStateFromFile() {
    try {
        if (fs.existsSync(BACKUP_FILE)) {
            const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
            if (data.paymentsDB) {
                paymentsDB.pending = new Map(data.paymentsDB.pending || []);
                paymentsDB.smsReceived = new Map(data.paymentsDB.smsReceived || []);
                paymentsDB.verified = new Map(data.paymentsDB.verified || []);
                paymentsDB.approved = new Map(data.paymentsDB.approved || []);
                paymentsDB.notifications = data.paymentsDB.notifications || [];
            }
            if (data.appearanceDB) {
                Object.assign(appearanceDB.settings, data.appearanceDB);
            }
            if (data.syncQueue) {
                syncQueue.items = data.syncQueue;
            }
            if (data.syncConfirmed) {
                syncQueue.confirmed = data.syncConfirmed;
            }
            if (data.adminCredentials) {
                if (data.adminCredentials.user) CONFIG.ADMIN_USER = data.adminCredentials.user;
                if (data.adminCredentials.pass) CONFIG.ADMIN_PASS = data.adminCredentials.pass;
            }
            console.log('[Backup] Etat restaure depuis fichier (sauvegarde du', data.lastSaved, ')');
        }
    } catch (err) {
        console.error('[Backup] Erreur chargement:', err.message);
    }
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// ROUTEROS CONNECTION HELPER
// ============================================
async function rosConnect() {
    const conn = new RouterOSAPI({
        host: CONFIG.ROUTER_HOST,
        user: CONFIG.ROUTER_USER,
        password: CONFIG.ROUTER_PASS,
        port: CONFIG.ROUTER_PORT
    });
    await conn.connect();
    return conn;
}

async function rosCommand(cmd, args) {
    const conn = await rosConnect();
    try {
        const result = await conn.write(cmd, args || []);
        conn.close();
        return result;
    } catch (err) {
        conn.close();
        throw err;
    }
}

// ============================================
// IN-MEMORY PAYMENT STORE
// ============================================
const paymentsDB = {
    pending: new Map(),      // paymentId -> payment record (client initiated, waiting for SMS)
    smsReceived: new Map(),  // transactionDigits -> parsed SMS data (from Telegram)
    verified: new Map(),     // phone_digits -> payment record (completed)
    approved: new Map(),     // paymentId -> approved record
    notifications: []        // Array of Telegram notification objects for admin panel
};

// ============================================
// SYNC QUEUE (MikroTik Pull Sync)
// ============================================
// Quand un paiement est verifie, les credentials sont ajoutes ici.
// Le MikroTik interroge /api/sync/pending pour recuperer les users a creer.
// Une fois crees sur le MikroTik, il appelle /api/sync/confirm.
const syncQueue = {
    items: [],  // Array of { syncId, username, password, profile, comment, createdAt }
    confirmed: [] // Array of confirmed syncIds (last 100)
};

// ============================================
// IN-MEMORY APPEARANCE STORE
// ============================================
const appearanceDB = {
    settings: {
        portalTitle: 'B&L info service - Hotspot',
        welcomeMsg: 'Veuillez vous connecter pour utiliser le service de hotspot internet',
        footerText: 'Propulse par B&L info service',
        primaryColor: '#3b82f6',
        nightMode: false,
        bgColor: '#1a1a2e',
        cardStyle: 'glassmorphism',
        animation: 'fadeInUp',
        logoData: '',
        faviconData: '',
        bgImageData: ''
    }
};

// ============================================
// OPERATOR DETECTION HELPER
// ============================================
function detectOperatorFromPhone(phone) {
    if (!phone) return 'unknown';
    if (phone.startsWith('032') || phone.startsWith('037')) return 'orange';
    if (phone.startsWith('034') || phone.startsWith('038')) return 'mvola';
    if (phone.startsWith('033')) return 'airtel';
    return 'unknown';
}

// ============================================
// GEMINI AI HELPER (Optional)
// ============================================
async function geminiValidatePayment(smsText) {
    if (!CONFIG.GEMINI_API_KEY) {
        console.log('[Gemini] Pas de cle API, validation auto desactivee');
        return null;
    }

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `Tu es un assistant qui analyse les SMS de paiement Mobile Money Madagascar.
Analyse ce SMS et extrais les informations de paiement.
Retourne UNIQUEMENT un JSON valide avec ces champs:
- "operator": "orange" | "mvola" | "airtel"
- "amount": nombre (montant en Ariary)
- "phone": numero de telephone de l'expediteur (format: 03XXXXXXXX)
- "transactionId": identifiant de transaction
- "last4Digits": les 4 derniers chiffres du numero de transaction
- "valid": true ou false

SMS a analyser:
${smsText}`
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 256
                    }
                })
            }
        );

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Extract JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log('[Gemini] SMS analyse:', parsed);
            return parsed;
        }

        return null;
    } catch (err) {
        console.error('[Gemini] Erreur:', err.message);
        return null;
    }
}

// ============================================
// AUTH MIDDLEWARE
// ============================================
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token manquant' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Token invalide ou expire' });
    }
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
    const syncPending = syncQueue.items.filter(i => !syncQueue.confirmed.includes(i.syncId)).length;
    try {
        const conn = await rosConnect();
        conn.close();
        res.json({ status: 'ok', mikrotik: 'connected', version: '4.0.0', syncMode: 'pull', syncPending, telegram: !!CONFIG.TELEGRAM_BOT_TOKEN, gemini: !!CONFIG.GEMINI_API_KEY });
    } catch (err) {
        res.json({ status: 'ok', mikrotik: 'disconnected', version: '4.0.0', syncMode: 'pull', syncPending, telegram: !!CONFIG.TELEGRAM_BOT_TOKEN, gemini: !!CONFIG.GEMINI_API_KEY });
    }
});

// ============================================
// AUTH ROUTES
// ============================================
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === CONFIG.ADMIN_USER && password === CONFIG.ADMIN_PASS) {
        const token = jwt.sign(
            { username, role: 'admin', iat: Math.floor(Date.now() / 1000) },
            CONFIG.JWT_SECRET,
            { expiresIn: CONFIG.JWT_EXPIRES }
        );
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'Identifiants incorrects' });
    }
});

// ============================================
// SYSTEM
// ============================================
app.get('/api/system', authMiddleware, async (req, res) => {
    try {
        const resource = await rosCommand('/system/resource/print');
        const identity = await rosCommand('/system/identity/print');
        const board = await rosCommand('/system/routerboard/print');

        const r = resource[0] || {};
        res.json({
            success: true,
            data: {
                boardName: r['board-name'] || '--',
                architecture: r.architecture || '--',
                version: r.version || '--',
                firmware: r['firmware-type'] || (board[0] && board[0]['current-firmware']) || '--',
                cpu: r.cpu || '--',
                cpuCount: r['cpu-count'] || '--',
                cpuFrequency: r['cpu-frequency'] || '--',
                cpuLoad: r['cpu-load'] || '0',
                totalMemory: r['total-memory'] || '0',
                freeMemory: r['free-memory'] || '0',
                totalHddSpace: r['total-hdd-space'] || '0',
                freeHddSpace: r['free-hdd-space'] || '0',
                uptime: r.uptime || '--',
                serialNumber: (board[0] && board[0]['serial-number']) || r['serial-number'] || '--',
                identity: (identity[0] && identity[0].name) || 'MikroTik'
            }
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/system/identity', authMiddleware, async (req, res) => {
    try {
        const identity = await rosCommand('/system/identity/print');
        res.json({ success: true, data: identity[0] || {} });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// HOTSPOT PROFILES
// ============================================
app.get('/api/hotspot/profiles', authMiddleware, async (req, res) => {
    try {
        const profiles = await rosCommand('/ip/hotspot/user/profile/print');
        res.json({ success: true, data: profiles });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.put('/api/hotspot/profiles/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        const args = ['.id=' + id];
        if (data.name) args.push('name=' + data.name);
        if (data.rateLimit !== undefined) args.push('rate-limit=' + data.rateLimit);
        if (data.sharedUsers) args.push('shared-users=' + data.sharedUsers);
        if (data.sessionTimeout !== undefined) args.push('session-timeout=' + data.sessionTimeout);

        await rosCommand('/ip/hotspot/user/profile/set', args);
        res.json({ success: true, message: 'Profil mis a jour' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// HOTSPOT SERVER PROFILES & SERVERS
// ============================================
app.get('/api/hotspot/server-profiles', authMiddleware, async (req, res) => {
    try {
        const profiles = await rosCommand('/ip/hotspot/profile/print');
        res.json({ success: true, data: profiles });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/hotspot/servers', authMiddleware, async (req, res) => {
    try {
        const servers = await rosCommand('/ip/hotspot/print');
        res.json({ success: true, data: servers });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// HOTSPOT USERS
// ============================================
app.get('/api/hotspot/users', authMiddleware, async (req, res) => {
    try {
        const users = await rosCommand('/ip/hotspot/user/print');
        res.json({ success: true, data: users });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/hotspot/users', authMiddleware, async (req, res) => {
    try {
        const { name, password, profile, macAddress } = req.body;
        const args = ['name=' + name, 'password=' + password, 'profile=' + profile];
        if (macAddress) args.push('mac-address=' + macAddress);

        const result = await rosCommand('/ip/hotspot/user/add', args);
        res.json({ success: true, data: result });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.put('/api/hotspot/users/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        const args = ['.id=' + id];
        if (data.name) args.push('name=' + data.name);
        if (data.password) args.push('password=' + data.password);
        if (data.profile) args.push('profile=' + data.profile);

        await rosCommand('/ip/hotspot/user/set', args);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.delete('/api/hotspot/users/:id', authMiddleware, async (req, res) => {
    try {
        await rosCommand('/ip/hotspot/user/remove', ['.id=' + req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// TICKET GENERATOR
// ============================================
app.post('/api/hotspot/tickets/generate', authMiddleware, async (req, res) => {
    try {
        const { profile, quantity, prefix, passwordLength, macAddress } = req.body;
        const qty = Math.min(parseInt(quantity) || 1, 50);
        const pwdLen = parseInt(passwordLength) || 6;
        const pref = prefix || 'T';

        const tickets = [];
        const errors = [];

        for (let i = 0; i < qty; i++) {
            const name = pref + Math.random().toString(36).substring(2, 2 + 5).toUpperCase();
            const pwd = Math.random().toString(36).substring(2, 2 + pwdLen).toUpperCase();

            // Try creating on MikroTik directly (if connected via tunnel)
            let createdOnRouter = false;
            const args = ['name=' + name, 'password=' + pwd, 'profile=' + profile];
            if (macAddress) args.push('mac-address=' + macAddress);

            try {
                await rosCommand('/ip/hotspot/user/add', args);
                createdOnRouter = true;
            } catch (rosErr) {
                // MikroTik unreachable - add to sync queue instead
                console.log('[Tickets] MikroTik inaccessible, ajout a la sync queue:', name);
            }

            // Always add to sync queue as backup (will be skipped if already confirmed)
            const syncId = uuidv4();
            syncQueue.items.push({
                syncId,
                username: name,
                password: pwd,
                profile: profile,
                comment: 'Ticket-' + pref + '-' + new Date().toISOString(),
                createdAt: new Date().toISOString(),
                directCreated: createdOnRouter
            });

            if (createdOnRouter) {
                // Mark as confirmed since already created on router
                syncQueue.confirmed.push(syncId);
            }

            tickets.push({ name, password: pwd, profile });
        }

        saveStateToFile();

        res.json({ success: true, created: tickets.length, tickets, errors, note: createdOnRouter ? '' : 'Tickets ajoutes a la sync queue (MikroTik inaccessible - sera synchronise automatiquement)' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// ACTIVE CONNECTIONS
// ============================================
app.get('/api/hotspot/active', authMiddleware, async (req, res) => {
    try {
        const active = await rosCommand('/ip/hotspot/active/print');
        res.json({ success: true, count: active.length, data: active });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.delete('/api/hotspot/active/:id', authMiddleware, async (req, res) => {
    try {
        await rosCommand('/ip/hotspot/active/remove', ['.id=' + req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/hotspot/active/disconnect-all', authMiddleware, async (req, res) => {
    try {
        const active = await rosCommand('/ip/hotspot/active/print');
        for (const user of active) {
            try {
                await rosCommand('/ip/hotspot/active/remove', ['.id=' + user['.id']]);
            } catch (e) { /* ignore individual errors */ }
        }
        res.json({ success: true, disconnected: active.length });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// NETWORK
// ============================================
app.get('/api/network/interfaces', authMiddleware, async (req, res) => {
    try {
        const interfaces = await rosCommand('/interface/print');
        res.json({ success: true, data: interfaces });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/network/dhcp-leases', authMiddleware, async (req, res) => {
    try {
        const leases = await rosCommand('/ip/dhcp-server/lease/print');
        res.json({ success: true, data: leases });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/network/wifi', authMiddleware, async (req, res) => {
    try {
        let wifi = [];
        try {
            wifi = await rosCommand('/interface/wifi/print');
        } catch (e) {
            try {
                wifi = await rosCommand('/interface/wireless/print');
            } catch (e2) {
                wifi = [];
            }
        }
        res.json({ success: true, data: wifi });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// TOOLS
// ============================================
app.post('/api/tools/reboot', authMiddleware, async (req, res) => {
    try {
        await rosCommand('/system/reboot');
        res.json({ success: true, message: 'Redemarrage en cours' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/tools/dns-flush', authMiddleware, async (req, res) => {
    try {
        await rosCommand('/ip/dns/cache/flush');
        res.json({ success: true, message: 'Cache DNS vide' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/tools/reset-counters', authMiddleware, async (req, res) => {
    try {
        const users = await rosCommand('/ip/hotspot/user/print');
        for (const u of users) {
            try {
                await rosCommand('/ip/hotspot/user/reset-counters', ['.id=' + u['.id']]);
            } catch (e) { /* ignore */ }
        }
        res.json({ success: true, message: 'Compteurs reinitialises' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/tools/backup', authMiddleware, async (req, res) => {
    try {
        await rosCommand('/system/backup/save', ['name=bl-hotspot-backup']);
        res.json({ success: true, message: 'Sauvegarde creee: bl-hotspot-backup' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/tools/ping', authMiddleware, async (req, res) => {
    try {
        const { host, count } = req.body;
        const result = await rosCommand('/ping', [
            'address=' + host,
            'count=' + (count || 4)
        ]);
        res.json({ success: true, data: result });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/tools/logs', authMiddleware, async (req, res) => {
    try {
        const logs = await rosCommand('/log/print', ['?topics=!time', '?topics=!?']);
        const limited = logs.slice(-100);
        res.json({ success: true, data: limited });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// SYNC
// ============================================
app.get('/api/hotspot/sync', authMiddleware, async (req, res) => {
    try {
        const [profiles, serverProfiles, servers, active] = await Promise.all([
            rosCommand('/ip/hotspot/user/profile/print'),
            rosCommand('/ip/hotspot/profile/print'),
            rosCommand('/ip/hotspot/print'),
            rosCommand('/ip/hotspot/active/print')
        ]);
        res.json({
            success: true,
            data: { profiles, serverProfiles, servers, activeCount: active.length }
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// MOBILE MONEY PAYMENT SYSTEM
// ============================================

/**
 * GET /api/payment/config
 * Get Mobile Money configuration (recipient numbers) - public for hotspot page
 */
app.get('/api/payment/config', (req, res) => {
    res.json({
        success: true,
        data: {
            recipients: {
                orange: CONFIG.MM_ORANGE_RECIPIENT,
                mvola: CONFIG.MM_MVOLA_RECIPIENT,
                airtel: CONFIG.MM_AIRTEL_RECIPIENT
            }
        }
    });
});

/**
 * POST /api/payment/initiate
 * Client initiates a payment - registers their intent
 * Body: { operator, phone, planId, planName, planPrice, planProfile, transactionDigits }
 */
app.post('/api/payment/initiate', async (req, res) => {
    try {
        const { operator, phone, planId, planName, planPrice, planProfile, transactionDigits } = req.body;
        if (!operator || !phone || !planPrice || !planProfile) {
            return res.status(400).json({ success: false, error: 'Donnees manquantes' });
        }

        const paymentId = uuidv4();
        const payment = {
            id: paymentId,
            operator,
            phone,
            planId,
            planName,
            planPrice,
            planProfile,
            transactionDigits: transactionDigits || null,
            status: 'pending',         // pending = waiting for SMS verification
            smsVerified: false,        // true when matching SMS received via Telegram
            autoValidated: false,      // true if Gemini auto-validated
            adminValidated: false,     // true if admin manually validated
            createdAt: new Date().toISOString(),
            verifiedAt: null,
            credentials: null
        };

        paymentsDB.pending.set(paymentId, payment);

        // Check if we already have a matching SMS notification
        if (transactionDigits) {
            const smsKey = operator + '_' + transactionDigits;
            const smsData = paymentsDB.smsReceived.get(smsKey);
            if (smsData) {
                payment.smsVerified = true;
                payment.status = 'sms_verified';
                console.log('[Payment] SMS correspondant trouve pour', paymentId);
            }
        }

        res.json({ success: true, paymentId, payment, status: payment.status });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * POST /api/payment/verify
 * Client verifies payment with phone + last 4 digits of transaction
 * Flow: Check if SMS was received via Telegram OR auto-validated by Gemini
 */
app.post('/api/payment/verify', async (req, res) => {
    try {
        const { operator, phone, transactionDigits, planId, planName, planPrice, planProfile } = req.body;

        if (!operator || !phone || !transactionDigits) {
            return res.status(400).json({ success: false, error: 'Informations manquantes' });
        }

        if (!/^\d{4}$/.test(transactionDigits)) {
            return res.status(400).json({ success: false, error: 'Les 4 derniers chiffres doivent etre des numeros' });
        }

        if (!planProfile) {
            return res.status(400).json({ success: false, error: 'Forfait non specifie' });
        }

        // Check for duplicate verification
        const dedupeKey = phone + '_' + transactionDigits;
        if (paymentsDB.verified.has(dedupeKey)) {
            const existing = paymentsDB.verified.get(dedupeKey);
            const age = Date.now() - new Date(existing.verifiedAt).getTime();
            if (age < 3600000) {
                return res.json({
                    success: true,
                    credentials: existing.credentials,
                    message: 'Paiement deja verifie'
                });
            }
        }

        // Check if SMS was received via Telegram for this transaction
        const smsKey = operator + '_' + transactionDigits;
        const smsData = paymentsDB.smsReceived.get(smsKey);

        // Check if Gemini auto-validated
        let autoValidated = false;
        if (smsData && smsData.autoValidated) {
            autoValidated = true;
        }

        // Check if admin manually approved a pending payment matching these criteria
        let adminApproved = false;
        for (const [pid, pending] of paymentsDB.pending.entries()) {
            if (pending.phone === phone &&
                pending.transactionDigits === transactionDigits &&
                pending.adminValidated) {
                adminApproved = true;
                break;
            }
        }

        // Payment is verified if: SMS received OR admin approved
        const isVerified = smsData || adminApproved || autoValidated;

        if (!isVerified) {
            // Register as pending - admin needs to validate
            const paymentId = uuidv4();
            const payment = {
                id: paymentId,
                operator,
                phone,
                planId,
                planName,
                planPrice,
                planProfile,
                transactionDigits,
                status: 'pending_verification',
                smsVerified: !!smsData,
                autoValidated,
                adminValidated: false,
                createdAt: new Date().toISOString(),
                verifiedAt: null,
                credentials: null
            };
            paymentsDB.pending.set(paymentId, payment);

            return res.json({
                success: false,
                status: 'pending_verification',
                message: 'Paiement en attente de verification. Un administrateur va verifier votre paiement.',
                paymentId
            });
        }

        // Payment verified! Add to sync queue for MikroTik to pull
        const username = 'MM' + phone.substring(phone.length - 4) + Math.random().toString(36).substring(2, 6).toUpperCase();
        const password = Math.random().toString(36).substring(2, 8).toUpperCase();
        const finalUsername = username;

        const syncId = uuidv4();
        syncQueue.items.push({
            syncId,
            username: finalUsername,
            password: password,
            profile: planProfile,
            comment: 'MobileMoney-' + operator + '-' + phone + '-TX' + transactionDigits,
            createdAt: new Date().toISOString()
        });

        console.log('[Payment] Credentials ajoutes a la sync queue:', finalUsername, '- En attente du MikroTik');

        const credentials = {
            username: finalUsername,
            password: password,
            plan: planName,
            operator: operator,
            phone: phone
        };

        const paymentId = uuidv4();
        const payment = {
            id: paymentId,
            operator,
            phone,
            planId,
            planName,
            planPrice,
            planProfile,
            transactionDigits,
            status: 'verified',
            smsVerified: !!smsData,
            autoValidated,
            adminValidated: adminApproved,
            createdAt: new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
            credentials
        };

        paymentsDB.pending.set(paymentId, payment);
        paymentsDB.verified.set(dedupeKey, payment);
        paymentsDB.approved.set(paymentId, payment);

        // Note: auto-connect is handled by MikroTik sync - user will be created on the router
        // when MikroTik polls /api/sync/pending
        saveStateToFile();

        res.json({
            success: true,
            credentials,
            paymentId,
            autoValidated,
            adminValidated: adminApproved
        });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * GET /api/payment/status/:paymentId
 * Client checks payment status (for pending verifications)
 */
app.get('/api/payment/status/:paymentId', async (req, res) => {
    try {
        const payment = paymentsDB.pending.get(req.params.paymentId);
        if (!payment) {
            return res.status(404).json({ success: false, error: 'Paiement non trouve' });
        }

        // If payment was admin-validated, create credentials and add to sync queue
        if (payment.adminValidated && !payment.credentials) {
            const username = 'MM' + payment.phone.substring(payment.phone.length - 4) + Math.random().toString(36).substring(2, 6).toUpperCase();
            const password = Math.random().toString(36).substring(2, 8).toUpperCase();

            // Add to sync queue instead of trying rosCommand
            const syncId = uuidv4();
            syncQueue.items.push({
                syncId,
                username: username,
                password: password,
                profile: payment.planProfile,
                comment: 'MobileMoney-Approved-' + payment.operator + '-' + payment.phone,
                createdAt: new Date().toISOString()
            });
            console.log('[Payment] Admin-approved credentials ajoutes a la sync queue:', username);

            payment.status = 'verified';
            payment.verifiedAt = new Date().toISOString();
            payment.credentials = {
                username,
                password,
                plan: payment.planName,
                operator: payment.operator,
                phone: payment.phone
            };

            const dedupeKey = payment.phone + '_' + payment.transactionDigits;
            paymentsDB.verified.set(dedupeKey, payment);
            paymentsDB.approved.set(payment.id, payment);

            saveStateToFile();
        }

        res.json({
            success: true,
            status: payment.status,
            credentials: payment.credentials,
            autoValidated: payment.autoValidated,
            adminValidated: payment.adminValidated
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * GET /api/payment/notifications
 * Get all Telegram SMS notifications (admin only)
 */
app.get('/api/payment/notifications', authMiddleware, async (req, res) => {
    try {
        res.json({
            success: true,
            data: paymentsDB.notifications.slice(-50).reverse()
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * POST /api/payment/manual-sms
 * Admin manually enters SMS content for parsing (alternative to Telegram)
 */
app.post('/api/payment/manual-sms', authMiddleware, async (req, res) => {
    try {
        const { smsText } = req.body;
        if (!smsText) {
            return res.status(400).json({ success: false, error: 'Texte SMS manquant' });
        }

        // Try Gemini auto-validation
        let parsed = null;
        if (CONFIG.GEMINI_API_KEY) {
            parsed = await geminiValidatePayment(smsText);
        }

        const notification = {
            id: uuidv4(),
            source: 'manual',
            text: smsText,
            parsed: parsed,
            autoValidated: parsed && parsed.valid,
            createdAt: new Date().toISOString()
        };

        // If no Gemini, try basic regex pattern matching (same as Telegram webhook)
        if (!parsed) {
            const amountMatch = smsText.match(/(\d[\d\s]*\d)\s*Ar/i) || smsText.match(/montant[:\s]*(\d[\d\s]*\d)/i);
            const phoneMatch = smsText.match(/(03[2-8]\d{7})/);
            const txMatch = smsText.match(/(?:TX|Trans|ref|n°)[:\s]*(\d{4,})/i);

            if (amountMatch || phoneMatch) {
                notification.parsed = {
                    amount: amountMatch ? parseInt(amountMatch[1].replace(/\s/g, '')) : null,
                    phone: phoneMatch ? phoneMatch[1] : null,
                    transactionId: txMatch ? txMatch[1] : null,
                    last4Digits: txMatch ? txMatch[1].slice(-4) : null,
                    operator: phoneMatch ? detectOperatorFromPhone(phoneMatch[1]) : null,
                    valid: true
                };
            }
        }

        paymentsDB.notifications.push(notification);

        // If auto-validated, store the SMS data
        if (parsed && parsed.valid && parsed.last4Digits) {
            const smsKey = (parsed.operator || 'unknown') + '_' + parsed.last4Digits;
            paymentsDB.smsReceived.set(smsKey, {
                ...notification,
                operator: parsed.operator,
                amount: parsed.amount,
                phone: parsed.phone,
                transactionId: parsed.transactionId,
                last4Digits: parsed.last4Digits
            });

            // Auto-approve any matching pending payments
            for (const [pid, payment] of paymentsDB.pending.entries()) {
                if (payment.transactionDigits === parsed.last4Digits &&
                    payment.status === 'pending_verification') {
                    payment.adminValidated = true;
                    payment.autoValidated = true;
                    payment.status = 'approved';
                    console.log('[Payment] Auto-approved payment', pid);
                }
            }
        }

        saveStateToFile();

        res.json({ success: true, notification, parsed });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * GET /api/payment/pending
 * List all pending payments (admin only)
 */
app.get('/api/payment/pending', authMiddleware, async (req, res) => {
    try {
        const pending = Array.from(paymentsDB.pending.values());
        const verified = Array.from(paymentsDB.approved.values());
        res.json({
            success: true,
            pending: pending.filter(p => p.status === 'pending' || p.status === 'pending_verification'),
            verified: verified
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * POST /api/payment/approve
 * Admin manually approves a payment
 */
app.post('/api/payment/approve', authMiddleware, async (req, res) => {
    try {
        const { paymentId } = req.body;
        const payment = paymentsDB.pending.get(paymentId);

        if (!payment) {
            return res.status(404).json({ success: false, error: 'Paiement non trouve' });
        }

        payment.adminValidated = true;
        payment.status = 'approved';

        saveStateToFile();

        res.json({ success: true, payment });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/payment/:id
 * Delete a pending payment
 */
app.delete('/api/payment/:id', authMiddleware, async (req, res) => {
    try {
        paymentsDB.pending.delete(req.params.id);
        paymentsDB.approved.delete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * GET /api/payment/stats
 * Payment statistics
 */
app.get('/api/payment/stats', authMiddleware, async (req, res) => {
    try {
        const pending = Array.from(paymentsDB.pending.values()).filter(p => p.status === 'pending' || p.status === 'pending_verification');
        const verified = Array.from(paymentsDB.approved.values());
        const totalRevenue = verified.reduce((sum, p) => sum + (p.planPrice || 0), 0);

        const byOperator = {};
        verified.forEach(p => {
            if (!byOperator[p.operator]) byOperator[p.operator] = { count: 0, revenue: 0 };
            byOperator[p.operator].count++;
            byOperator[p.operator].revenue += (p.planPrice || 0);
        });

        res.json({
            success: true,
            totalPending: pending.length,
            totalVerified: verified.length,
            totalRevenue,
            byOperator,
            smsNotifications: paymentsDB.notifications.length
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * GET /api/payment/settings
 * Get payment settings (admin only)
 */
app.get('/api/payment/settings', authMiddleware, async (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                recipients: {
                    orange: CONFIG.MM_ORANGE_RECIPIENT,
                    mvola: CONFIG.MM_MVOLA_RECIPIENT,
                    airtel: CONFIG.MM_AIRTEL_RECIPIENT
                },
                telegram: {
                    configured: !!CONFIG.TELEGRAM_BOT_TOKEN,
                    chatId: CONFIG.TELEGRAM_CHAT_ID ? '****' + CONFIG.TELEGRAM_CHAT_ID.slice(-4) : ''
                },
                gemini: {
                    configured: !!CONFIG.GEMINI_API_KEY,
                    autoValidate: CONFIG.AUTO_VALIDATE
                }
            }
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// APPEARANCE / THEME
// ============================================

/**
 * GET /api/appearance
 * Get appearance settings (public - for hotspot pages to load)
 */
app.get('/api/appearance', (req, res) => {
    res.json({ success: true, data: appearanceDB.settings });
});

/**
 * GET /api/appearance/admin
 * Get appearance settings (admin only - includes all data)
 */
app.get('/api/appearance/admin', authMiddleware, (req, res) => {
    res.json({ success: true, data: appearanceDB.settings });
});

/**
 * PUT /api/appearance
 * Update appearance settings (admin only)
 */
app.put('/api/appearance', authMiddleware, (req, res) => {
    try {
        const data = req.body;
        const allowedFields = ['portalTitle', 'welcomeMsg', 'footerText', 'primaryColor', 
            'nightMode', 'bgColor', 'cardStyle', 'animation', 'logoData', 'faviconData', 'bgImageData'];
        
        for (const field of allowedFields) {
            if (data[field] !== undefined) {
                appearanceDB.settings[field] = data[field];
            }
        }
        
        saveStateToFile();
        
        res.json({ success: true, data: appearanceDB.settings });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// TELEGRAM WEBHOOK
// ============================================
/**
 * POST /api/telegram/webhook
 * Receives SMS notifications from Telegram Bot
 * (forwarded from Android SMS Forwarder app)
 */
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        const body = req.body;

        // Accept messages even without TELEGRAM_BOT_TOKEN configured (for testing)
        if (body.message) {
            const chatId = body.message.chat?.id?.toString();
            const text = body.message.text || '';

            console.log('[Telegram] Message recu de chat', chatId, ':', text.substring(0, 100));

            // Only process messages from our configured chat
            if (CONFIG.TELEGRAM_CHAT_ID && chatId !== CONFIG.TELEGRAM_CHAT_ID) {
                console.log('[Telegram] Chat ID non autorise:', chatId);
                return res.json({ ok: true });
            }

            // Store notification
            const notification = {
                id: uuidv4(),
                source: 'telegram',
                chatId: chatId,
                text: text,
                fromTelegram: true,
                parsed: null,
                autoValidated: false,
                createdAt: new Date().toISOString(),
                messageId: body.message.message_id
            };

            // Try Gemini auto-validation
            if (CONFIG.GEMINI_API_KEY) {
                const parsed = await geminiValidatePayment(text);
                if (parsed && parsed.valid) {
                    notification.parsed = parsed;
                    notification.autoValidated = CONFIG.AUTO_VALIDATE;

                    // Store SMS data for matching
                    if (parsed.last4Digits) {
                        const smsKey = (parsed.operator || 'unknown') + '_' + parsed.last4Digits;
                        paymentsDB.smsReceived.set(smsKey, {
                            ...notification,
                            operator: parsed.operator,
                            amount: parsed.amount,
                            phone: parsed.phone,
                            transactionId: parsed.transactionId,
                            last4Digits: parsed.last4Digits
                        });

                        // Auto-approve matching pending payments if enabled
                        if (CONFIG.AUTO_VALIDATE) {
                            for (const [pid, payment] of paymentsDB.pending.entries()) {
                                if (payment.transactionDigits === parsed.last4Digits &&
                                    payment.status === 'pending_verification') {
                                    payment.adminValidated = true;
                                    payment.autoValidated = true;
                                    payment.status = 'approved';
                                    console.log('[Payment] Auto-approved via Gemini:', pid);
                                }
                            }
                        }
                    }
                }
            }

            paymentsDB.notifications.push(notification);

            // If no Gemini, store as raw SMS for admin to manually verify
            if (!notification.parsed) {
                // Try basic pattern matching for common Madagascar SMS formats
                const amountMatch = text.match(/(\d[\d\s]*\d)\s*Ar/i) || text.match(/montant[:\s]*(\d[\d\s]*\d)/i);
                const phoneMatch = text.match(/(03[2-8]\d{7})/);
                const txMatch = text.match(/(?:TX|Trans|ref|n°)[:\s]*(\d{4,})/i);

                if (amountMatch || phoneMatch) {
                    notification.parsed = {
                        amount: amountMatch ? parseInt(amountMatch[1].replace(/\s/g, '')) : null,
                        phone: phoneMatch ? phoneMatch[1] : null,
                        transactionId: txMatch ? txMatch[1] : null,
                        last4Digits: txMatch ? txMatch[1].slice(-4) : null,
                        operator: text.toLowerCase().includes('orange') ? 'orange' :
                                  text.toLowerCase().includes('mvola') ? 'mvola' :
                                  text.toLowerCase().includes('airtel') ? 'airtel' :
                                  phoneMatch ? detectOperatorFromPhone(phoneMatch[1]) : null,
                        valid: !!(amountMatch || phoneMatch)
                    };

                    // Store for matching even without full validation
                    if (notification.parsed.last4Digits && notification.parsed.operator) {
                        const smsKey = notification.parsed.operator + '_' + notification.parsed.last4Digits;
                        paymentsDB.smsReceived.set(smsKey, {
                            ...notification,
                            operator: notification.parsed.operator,
                            amount: notification.parsed.amount,
                            phone: notification.parsed.phone,
                            last4Digits: notification.parsed.last4Digits
                        });
                    }
                }
            }
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('[Telegram Webhook] Erreur:', err.message);
        res.json({ ok: true }); // Always return ok to Telegram
    }
});

/**
 * GET /api/telegram/setup
 * Setup Telegram webhook (admin only)
 */
app.get('/api/telegram/setup', authMiddleware, async (req, res) => {
    try {
        if (!CONFIG.TELEGRAM_BOT_TOKEN) {
            return res.json({ success: false, error: 'TELEGRAM_BOT_TOKEN non configure' });
        }

        const backendUrl = req.protocol + '://' + req.get('host');
        const webhookUrl = backendUrl + '/api/telegram/webhook';

        const response = await fetch(
            `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/setWebhook`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: webhookUrl })
            }
        );

        const result = await response.json();
        res.json({ success: result.ok, webhookUrl, result });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// PLANS (Public - for hotspot login page)
// ============================================
app.get('/api/plans', async (req, res) => {
    res.json({
        success: true,
        data: [
            { id: '1h', name: '1 Heure', price: 500, profile: 'profile_1heure', validity: '24h' },
            { id: '2h', name: '2 Heures', price: 1000, profile: 'profile_2h-se', validity: '24h' },
            { id: '5h', name: '5 Heures', price: 2000, profile: 'profile_5heure', validity: '72h' },
            { id: '1j', name: '1 Jour', price: 5000, profile: 'profile_1jour', validity: '1 appareil' },
            { id: '7j', name: '7 Jours', price: 8000, profile: 'profile_7jour', validity: '1 appareil' },
            { id: 'ecran', name: '1 Mois Ecran', price: 13000, profile: 'profile_Ecran', validity: '1 ecran plat' },
            { id: '1m', name: '1 Mois', price: 20000, profile: 'profile_1mois', validity: '1 appareil' },
            { id: '1m3', name: '1 Mois 3 App', price: 50000, profile: 'profile_1mois_3app', validity: '3 appareils' }
        ]
    });
});

// ============================================
// ADMIN PASSWORD CHANGE
// ============================================
app.post('/api/auth/change-password', authMiddleware, (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Ancien et nouveau mot de passe requis' });
        }
        if (newPassword.length < 4) {
            return res.status(400).json({ success: false, error: 'Le nouveau mot de passe doit avoir au moins 4 caracteres' });
        }
        // Verify current password
        if (req.user.username !== CONFIG.ADMIN_USER || currentPassword !== CONFIG.ADMIN_PASS) {
            return res.status(401).json({ success: false, error: 'Mot de passe actuel incorrect' });
        }
        // Update password
        CONFIG.ADMIN_PASS = newPassword;
        saveStateToFile();
        res.json({ success: true, message: 'Mot de passe modifie avec succes' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// MIKROTIK SYNC (Pull from RouterOS)
// ============================================

/**
 * Sync middleware - authenticate with SYNC_TOKEN
 * The MikroTik uses this token to authenticate sync requests
 */
function syncAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const tokenFromQuery = req.query.token;

    if (tokenFromHeader === CONFIG.SYNC_TOKEN || tokenFromQuery === CONFIG.SYNC_TOKEN) {
        return next();
    }
    return res.status(401).json({ success: false, error: 'Sync token invalide' });
}

/**
 * GET /api/sync/pending
 * MikroTik polls this endpoint to get pending users to create
 * Returns all users waiting in the sync queue
 */
app.get('/api/sync/pending', syncAuthMiddleware, (req, res) => {
    try {
        // Remove items older than 24 hours (cleanup)
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        syncQueue.items = syncQueue.items.filter(item => {
            return new Date(item.createdAt).getTime() > cutoff;
        });

        // Return pending items (not yet confirmed)
        const pending = syncQueue.items.filter(item => !syncQueue.confirmed.includes(item.syncId));

        res.json({
            success: true,
            count: pending.length,
            data: pending
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * POST /api/sync/confirm
 * MikroTik confirms that a user has been created successfully
 * Body: { syncIds: ["id1", "id2", ...] }
 */
app.post('/api/sync/confirm', syncAuthMiddleware, (req, res) => {
    try {
        const { syncIds } = req.body;
        if (!syncIds || !Array.isArray(syncIds)) {
            return res.status(400).json({ success: false, error: 'syncIds requis (tableau)' });
        }

        let confirmedCount = 0;
        for (const syncId of syncIds) {
            if (!syncQueue.confirmed.includes(syncId)) {
                syncQueue.confirmed.push(syncId);
                confirmedCount++;

                // Find the item and log it
                const item = syncQueue.items.find(i => i.syncId === syncId);
                if (item) {
                    console.log('[Sync] Utilisateur confirme par MikroTik:', item.username);
                }
            }
        }

        // Keep only last 100 confirmed IDs
        if (syncQueue.confirmed.length > 100) {
            syncQueue.confirmed = syncQueue.confirmed.slice(-100);
        }

        // Remove confirmed items from queue that are older than 1 hour
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        syncQueue.items = syncQueue.items.filter(item => {
            if (syncQueue.confirmed.includes(item.syncId) && new Date(item.createdAt).getTime() < oneHourAgo) {
                return false;
            }
            return true;
        });

        saveStateToFile();

        res.json({
            success: true,
            confirmed: confirmedCount,
            remaining: syncQueue.items.filter(i => !syncQueue.confirmed.includes(i.syncId)).length
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * GET /api/sync/status
 * Get sync queue status (admin only)
 */
app.get('/api/sync/status', authMiddleware, (req, res) => {
    try {
        const pending = syncQueue.items.filter(i => !syncQueue.confirmed.includes(i.syncId));
        const confirmed = syncQueue.items.filter(i => syncQueue.confirmed.includes(i.syncId));

        res.json({
            success: true,
            pendingCount: pending.length,
            confirmedCount: confirmed.length,
            pending: pending,
            confirmed: confirmed.slice(-20) // Last 20 confirmed
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

/**
 * POST /api/sync/add
 * Manually add a user to the sync queue (admin only)
 * This is used by the ticket generator and admin panel
 */
app.post('/api/sync/add', authMiddleware, (req, res) => {
    try {
        const { username, password, profile, comment } = req.body;
        if (!username || !password || !profile) {
            return res.status(400).json({ success: false, error: 'username, password et profile requis' });
        }

        const syncId = uuidv4();
        syncQueue.items.push({
            syncId,
            username,
            password,
            profile,
            comment: comment || 'Manual-' + new Date().toISOString(),
            createdAt: new Date().toISOString()
        });

        saveStateToFile();

        console.log('[Sync] User ajoute manuellement a la queue:', username);
        res.json({ success: true, syncId, username, message: 'Utilisateur ajoute a la file d\'attente MikroTik' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// START SERVER
// ============================================
app.listen(CONFIG.PORT, () => {
    console.log('========================================');
    console.log('  B&L info service - Hotspot v4 Backend');
    console.log('========================================');
    console.log('  Port: ' + CONFIG.PORT);
    console.log('  Router: ' + CONFIG.ROUTER_HOST + ':' + CONFIG.ROUTER_PORT);
    console.log('  Sync Mode: PULL (MikroTik tire les users)');
    console.log('  Sync Queue: ' + syncQueue.items.filter(i => !syncQueue.confirmed.includes(i.syncId)).length + ' en attente');
    console.log('  Hotspot Interface: ' + CONFIG.HOTSPOT_INTERFACE);
    console.log('  Telegram Bot: ' + (CONFIG.TELEGRAM_BOT_TOKEN ? 'Configure' : 'Non configure'));
    console.log('  Gemini AI: ' + (CONFIG.GEMINI_API_KEY ? 'Configure' : 'Non configure'));
    console.log('  Auto-Validate: ' + (CONFIG.AUTO_VALIDATE ? 'Active' : 'Desactive'));
    console.log('  Mobile Money: Orange Money, MVola, Airtel Money');
    console.log('========================================');

    // Load state on startup
    loadStateFromFile();

    // Auto-save every 30 minutes
    setInterval(saveStateToFile, 30 * 60 * 1000);
    console.log('  Auto-Backup: Toutes les 30 minutes');
});
