const express = require('express');
const app = express();
const { Telegraf, Markup } = require('telegraf');


const app = express();
app.use(express.json());
app.use(express.static('public'));

// CONFIGURAZIONE VARIABILI D'AMBIENTE
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;               // La tua chiave d'accesso MT4
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;   // Il tuo ID chat Telegram

// MAPPA MULTI-ACCOUNT IN MEMORIA (chiave: accountNumber)
let accounts = {};

// --- MIDDLEWARE AUTENTICAZIONE MT4 ---
const authenticateMT4 = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }
  next();
};

// --- ENDPOINT PER MT4 (PING DATA MULTI-ACCOUNT) ---
app.post('/api/mt4/ping', authenticateMT4, (req, res) => {
  const { accountNumber, balance, equity, profit, openFloating, drawdown, openOrders, eaName } = req.body;

  // Usa l'accountNumber come ID univoco, altrimenti ripiega sul nome EA/Simbolo
  const id = accountNumber ? accountNumber.toString() : (eaName || 'Conto_Sconosciuto');

  // Mantiene lo stato di emergencyStop preesistente se il conto era già registrato
  const existingEmergencyStop = accounts[id] ? accounts[id].emergencyStop : false;

  accounts[id] = {
    accountNumber: id,
    balance: parseFloat(balance) || 0,
    equity: parseFloat(equity) || 0,
    profit: parseFloat(profit) || 0,             // Chiuso oggi + Flottante
    openFloating: parseFloat(openFloating) || 0, // Soli ordini a mercato
    drawdown: parseFloat(drawdown) || 0,
    openOrders: parseInt(openOrders) || 0,
    eaName: eaName || 'MT4 Client',
    lastUpdate: new Date(),
    emergencyStop: existingEmergencyStop
  };

  // Risponde a MT4 con l'esito dello stop per il conto specifico
  res.json({
    status: 'ok',
    accountNumber: id,
    emergencyStop: accounts[id].emergencyStop
  });
});


// Endpoint per la lettura dello stato da Scriptable / Web App
app.get('/api/app/status', (req, res) => {
 
  const apiKey = req.headers['x-api-key'] || req.query.key;
  if (!apiKey || apiKey !== process.env.API_KEY) {
  return res.status(401).json({ error: 'Non autorizzato' });
  }
  
  res.json(accounts);
});

// --- LOGICA BOT TELEGRAM MULTI-ACCOUNT ---
if (TELEGRAM_BOT_TOKEN) {
  try {
    const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    // Helper per costruire la Dashboard Principale
    const formatDashboardMessage = () => {
      const accountKeys = Object.keys(accounts);

      if (accountKeys.length === 0) {
        return '⚠️ *Nessun conto MT4 ancora connesso.*\n\n_Assicurati che l\'EA sia attivo e invii i dati al server._';
      }

      let msg = `📊 *OVERVIEW MULTI-ACCOUNT MT4*\n━━━━━━━━━━━━━━━━━━━\n`;
      let totalBalance = 0;
      let totalEquity = 0;
      let totalProfit = 0;

      accountKeys.forEach((id) => {
        const acc = accounts[id];
        totalBalance += acc.balance;
        totalEquity += acc.equity;
        totalProfit += acc.profit;

        const timeDiff = Math.round((new Date() - new Date(acc.lastUpdate)) / 1000);
        const statusIcon = timeDiff < 15 ? '🟢' : '🔴';
        const profitIcon = acc.profit >= 0 ? '📈' : '📉';
        const killIcon = acc.emergencyStop ? '🚨 *KILL ATTIVO*' : '✅ OK';

        msg += `\n${statusIcon} *Conto ID:* \`${acc.accountNumber}\` (${acc.eaName})
💰 *Balance:* \`€${acc.balance.toFixed(2)}\` | *Equity:* \`€${acc.equity.toFixed(2)}\`
${profitIcon} *Risultato Oggi:* \`€${acc.profit.toFixed(2)}\`
📊 *Flottante Aperti:* \`€${acc.openFloating.toFixed(2)}\`
⚠️ *Drawdown:* \`${acc.drawdown.toFixed(2)}%\` | *Ordini:* \`${acc.openOrders}\`
🛡️ *Stato:* ${killIcon}\n`;
      });

      msg += `━━━━━━━━━━━━━━━━━━━
💳 *Totale Balance:* \`€${totalBalance.toFixed(2)}\`
📊 *Totale Equity:* \`€${totalEquity.toFixed(2)}\`
📈 *Profitto Netto Cumulativo:* \`€${totalProfit.toFixed(2)}\``;

      return msg;
    };

    // Helper per creare i pulsanti interattivi
    const getMainMenuKeyboard = () => {
      const accountKeys = Object.keys(accounts);
      const buttons = [];

      // Riga 1: Refresh
      buttons.push([Markup.button.callback('🔄 Aggiorna Dashboard', 'REFRESH_DASHBOARD')]);

      // Righe per il Kill Switch per singolo conto
      accountKeys.forEach((id) => {
        buttons.push([Markup.button.callback(`🚨 Emergency Kill (Conto ${id})`, `CONFIRM_KILL_${id}`)]);
      });

      // Se ci sono più conti, aggiunge il pulsante di Kill Globale
      if (accountKeys.length > 1) {
        buttons.push([Markup.button.callback('⚡ EMERGENCY KILL GLOBALE (TUTTI)', 'CONFIRM_KILL_ALL')]);
      }

      return Markup.inlineKeyboard(buttons);
    };

    // Middleware Controllo Sicurezza Utente Telegram
    bot.use((ctx, next) => {
      if (TELEGRAM_CHAT_ID && ctx.chat && ctx.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) {
        return ctx.reply('⛔ Non sei autorizzato ad accedere a questo Bot.');
      }
      return next();
    });

    // Comando /start
    bot.start((ctx) => {
      ctx.reply(formatDashboardMessage(), { parse_mode: 'Markdown', ...getMainMenuKeyboard() });
    });

    // Azione: Aggiorna Dashboard
    bot.action('REFRESH_DASHBOARD', async (ctx) => {
      try {
        await ctx.editMessageText(formatDashboardMessage(), { parse_mode: 'Markdown', ...getMainMenuKeyboard() });
        await ctx.answerCbQuery('Dashboard aggiornata!');
      } catch (err) {
        await ctx.answerCbQuery('Nessun dato nuovo.');
      }
    });

    // Azione: Richiesta Conferma Kill Switch Singolo
    bot.action(/^CONFIRM_KILL_(.+)$/, async (ctx) => {
      const accId = ctx.match[1];
      if (accId === 'ALL') return; // Gestito da action specifica

      const confirmKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(`⚠️ SÌ, CHIUDI CONTO ${accId}`, `EXECUTE_KILL_${accId}`),
          Markup.button.callback('❌ Annulla', 'CANCEL_KILL')
        ]
      ]);

      await ctx.reply(`⚠️ *CONFERMA EMERGENZA*\n\nStai per attivare lo stop per il *Conto ${accId}*.\nTutte le posizioni aperte verranno chiuse immediatamente. Confermi?`, {
        parse_mode: 'Markdown',
        ...confirmKeyboard
      });
      await ctx.answerCbQuery();
    });

    // Azione: Richiesta Conferma Kill Switch Globale
    bot.action('CONFIRM_KILL_ALL', async (ctx) => {
      const confirmKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔴 SÌ, CHIUDI TUTTI I CONTI 🔴', 'EXECUTE_KILL_ALL'),
          Markup.button.callback('❌ Annulla', 'CANCEL_KILL')
        ]
      ]);

      await ctx.reply('🚨 *ATTENZIONE: KILL SWITCH GLOBALE*\n\nStai per chiudere le posizioni di *TUTTI I CONTI CONNESSI*!\nSei sicuro di voler procedere?', {
        parse_mode: 'Markdown',
        ...confirmKeyboard
      });
      await ctx.answerCbQuery();
    });

    // Azione: Esecuzione Kill Switch Singolo
    bot.action(/^EXECUTE_KILL_(.+)$/, async (ctx) => {
      const accId = ctx.match[1];

      if (accId === 'ALL') {
        Object.keys(accounts).forEach((id) => {
          accounts[id].emergencyStop = true;
        });
        await ctx.reply('🚨 *KILL SWITCH GLOBALE ATTIVATO!* Inviato ordine di chiusura a tutti i conti.', { parse_mode: 'Markdown' });
      } else if (accounts[accId]) {
        accounts[accId].emergencyStop = true;
        await ctx.reply(`🚨 *KILL SWITCH ATTIVATO PER CONTO ${accId}!* Inviata richiesta di chiusura immediata.`, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('❌ Conto non trovato.');
      }

      await ctx.answerCbQuery();
    });

    // Azione: Annulla / Reset Kill Switch
    bot.action('CANCEL_KILL', async (ctx) => {
      Object.keys(accounts).forEach((id) => {
        accounts[id].emergencyStop = false;
      });
      await ctx.reply('✅ Operazione annullata. Lo stato degli stop di emergenza è stato ripristinato a normale.', { parse_mode: 'Markdown' });
      await ctx.answerCbQuery();
    });

    bot.launch();
    console.log('Bot Telegram Multi-Account avviato con successo.');
  } catch (err) {
    console.error('Errore durante l’avvio del Bot Telegram:', err.message);
  }
} else {
  console.log('TELEGRAM_BOT_TOKEN non configurato.');
}

// AVVIO SERVER HTTP
app.listen(PORT, () => {
  console.log(`Server HTTP attivo sulla porta ${PORT}`);
});
