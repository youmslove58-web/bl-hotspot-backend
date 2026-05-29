# B&L Info Service - Hotspot v4 Backend

Backend pour portail captif MikroTik avec paiement Mobile Money.

## Architecture (MikroTik Pull Sync)

```
Client WiFi --> Page Hotspot --> Render Backend
                                    |
SMS Forwarder --> Telegram Bot --> Webhook --> Backend
                                    |                |
Gemini AI --> Auto-validate         |     File d'attente sync
                                    |                |
MikroTik <-- GET /api/sync/pending <--   (credentials en attente)
MikroTik --> POST /api/sync/confirm --> (confirmation creation)
```

## Installation sur Render

1. Fork/clone ce repo sur GitHub
2. Creer un nouveau service Web sur Render (render.com)
3. Connecter au repo GitHub
4. Build Command: `npm install`
5. Start Command: `node server.js`
6. Ajouter les variables d'environnement (voir .env.example)

## Variables d'environnement

| Variable | Description | Obligatoire |
|----------|-------------|-------------|
| ROUTER_HOST | IP du MikroTik (pour reference) | Non |
| ROUTER_USER | Utilisateur MikroTik API | Non |
| ROUTER_PASS | Mot de passe MikroTik API | Non |
| ROUTER_PORT | Port MikroTik API (8728) | Non |
| ADMIN_USER | Nom d'utilisateur admin | Oui |
| ADMIN_PASS | Mot de passe admin | Oui |
| JWT_SECRET | Cle secrete JWT | Oui |
| SYNC_TOKEN | Token pour sync MikroTik | Oui |
| MM_ORANGE_RECIPIENT | Numero Orange Money | Oui |
| MM_MVOLA_RECIPIENT | Numero MVola | Oui |
| MM_AIRTEL_RECIPIENT | Numero Airtel Money | Oui |
| TELEGRAM_BOT_TOKEN | Token du bot Telegram | Non |
| TELEGRAM_CHAT_ID | ID du chat Telegram | Non |
| GEMINI_API_KEY | Cle API Gemini AI | Non |
| AUTO_VALIDATE | Validation auto (true/false) | Non |

## Installation du script MikroTik

1. Ouvrir WinBox --> System --> Scripts
2. Cliquer "Add" --> Nom: `bl-hotspot-sync`
3. Copier le contenu de `mikrotik-sync-script.rsc`
4. Modifier `backendUrl` et `syncToken`
5. Ajouter le scheduler:

```
/system/scheduler add name=bl-hotspot-sync interval=10s \
  on-event="/system/script/run bl-hotspot-sync" \
  policy=read,write,test
```

## API Endpoints

### Public
- `GET /health` - Status du backend
- `GET /api/plans` - Liste des forfaits
- `GET /api/payment/config` - Config Mobile Money
- `GET /api/appearance` - Apparence du portail

### Auth
- `POST /api/auth/login` - Connexion admin
- `POST /api/auth/change-password` - Changer mot de passe

### Paiement Mobile Money
- `POST /api/payment/initiate` - Initiier un paiement
- `POST /api/payment/verify` - Verifier un paiement
- `GET /api/payment/status/:id` - Statut d'un paiement
- `GET /api/payment/pending` - Paiements en attente (admin)
- `POST /api/payment/approve` - Approuver un paiement (admin)
- `GET /api/payment/stats` - Statistiques (admin)
- `GET /api/payment/settings` - Parametres (admin)
- `POST /api/payment/manual-sms` - Saisir SMS manuellement (admin)

### MikroTik Sync
- `GET /api/sync/pending` - Utilisateurs en attente (MikroTik)
- `POST /api/sync/confirm` - Confirmer creation (MikroTik)
- `GET /api/sync/status` - Statut sync (admin)
- `POST /api/sync/add` - Ajouter user manuellement (admin)

### Telegram
- `POST /api/telegram/webhook` - Webhook SMS
- `GET /api/telegram/setup` - Configurer webhook (admin)

### Admin (RouterOS - si tunnel disponible)
- `GET /api/system` - Infos systeme
- `GET /api/hotspot/users` - Liste utilisateurs
- `POST /api/hotspot/users` - Creer utilisateur
- `GET /api/hotspot/active` - Connexions actives
- `POST /api/hotspot/tickets/generate` - Generer tickets
