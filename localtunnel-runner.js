import localtunnel from 'localtunnel';

const SUBDOMAIN = 'kellamonitor';
const PORT = 5000;

async function startTunnel() {
  try {
    console.log(`[Localtunnel] Connecting subdomain: '${SUBDOMAIN}' on port ${PORT}...`);
    const tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
    
    console.log(`=======================================================`);
    console.log(`🌐 Public Custom URL: ${tunnel.url}`);
    console.log(`=======================================================`);

    tunnel.on('close', () => {
      console.log('[Localtunnel] Tunnel connection closed. Reconnecting in 3s...');
      setTimeout(startTunnel, 3000);
    });

    tunnel.on('error', (err) => {
      console.error('[Localtunnel] Error:', err?.message || err);
      try { tunnel.close(); } catch (e) {}
      setTimeout(startTunnel, 5000);
    });
  } catch (err) {
    console.error('[Localtunnel] Connection error:', err?.message || err);
    setTimeout(startTunnel, 5000);
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Localtunnel] Uncaught exception:', err?.message || err);
});

startTunnel();
