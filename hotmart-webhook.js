// ═══════════════════════════════════════════════════════
// Netlify Function — Hotmart Webhook
// Recebe pagamento aprovado → gera código → salva no Firebase → envia e-mail
// ═══════════════════════════════════════════════════════

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

// ── Configuração Firebase Admin ──
function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

// ── Gera código único (1 letra + 7 números) ──
function gerarCodigo() {
  const letra = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const nums  = Math.floor(1000000 + Math.random() * 9000000).toString();
  return letra + nums;
}

// ── Envia e-mail via Resend ──
async function enviarEmail(destinatario, nomeCliente, codigo, expiraEm) {
  const dataExpira = expiraEm.toLocaleDateString('pt-BR');
  const appUrl = process.env.APP_URL || 'https://gentle-otter-400d9f.netlify.app';

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f13;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px">

    <div style="text-align:center;margin-bottom:28px">
      <div style="font-size:2.5rem">📸</div>
      <h1 style="color:#00e5a0;font-size:1.4rem;margin:8px 0 4px">Gerador de Posts</h1>
      <p style="color:#6b6b80;font-size:0.85rem;margin:0">Seu acesso está pronto!</p>
    </div>

    <div style="background:#18181f;border:1px solid #2c2c38;border-radius:16px;padding:28px;margin-bottom:20px">
      <p style="color:#f0f0f5;font-size:0.95rem;margin:0 0 20px">Olá, <b>${nomeCliente}</b>! 🎉</p>
      <p style="color:#a0a0b0;font-size:0.88rem;margin:0 0 24px;line-height:1.6">
        Seu pagamento foi confirmado e seu acesso ao <b style="color:#f0f0f5">Gerador de Posts para Instagram</b> já está ativo.
      </p>

      <div style="background:#0f0f13;border:2px solid #00e5a0;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
        <p style="color:#6b6b80;font-size:0.75rem;margin:0 0 8px;text-transform:uppercase;letter-spacing:.1em">Seu código de acesso</p>
        <div style="color:#00e5a0;font-size:2rem;font-weight:900;letter-spacing:.15em;font-family:monospace">${codigo}</div>
        <p style="color:#6b6b80;font-size:0.72rem;margin:8px 0 0">Válido até ${dataExpira}</p>
      </div>

      <a href="${appUrl}" style="display:block;background:linear-gradient(135deg,#00e5a0,#00b8ff);color:#000;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:800;font-size:0.95rem;margin-bottom:20px">
        📸 Acessar o App
      </a>

      <div style="background:#202028;border-radius:10px;padding:16px">
        <p style="color:#a0a0b0;font-size:0.82rem;margin:0 0 8px;font-weight:700">Como entrar:</p>
        <ol style="color:#a0a0b0;font-size:0.82rem;margin:0;padding-left:18px;line-height:1.8">
          <li>Acesse o link acima</li>
          <li>Digite seu código: <b style="color:#00e5a0;letter-spacing:.08em">${codigo}</b></li>
          <li>Clique em <b style="color:#f0f0f5">Entrar</b></li>
          <li>Configure e comece a criar seus posts! 🚀</li>
        </ol>
      </div>
    </div>

    <p style="color:#6b6b80;font-size:0.72rem;text-align:center;line-height:1.6;margin:0">
      Guarde este e-mail com seu código de acesso.<br>
      Dúvidas? Responda este e-mail.
    </p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Gerador de Posts <onboarding@resend.dev>',
      to:   [destinatario],
      subject: `🎉 Seu código de acesso: ${codigo}`,
      html,
    }),
  });
  return res.ok;
}

// ── Handler principal ──
exports.handler = async (event) => {
  // Aceita apenas POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Verifica token de segurança da Hotmart
  const hottok = event.headers['x-hotmart-hottok'] || event.headers['hottok'];
  if (process.env.HOTMART_HOTTOK && hottok !== process.env.HOTMART_HOTTOK) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // Filtra apenas pagamentos aprovados
  const event_type = payload?.event || payload?.data?.event;
  const status     = payload?.data?.purchase?.status || payload?.purchase?.status;

  const aprovado = 
    event_type === 'PURCHASE_APPROVED' ||
    event_type === 'PURCHASE_COMPLETE' ||
    status === 'APPROVED' ||
    status === 'COMPLETE';

  if (!aprovado) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'Evento ignorado: ' + event_type }) };
  }

  // Extrai dados do comprador
  const buyer = payload?.data?.buyer || payload?.buyer || {};
  const purchase = payload?.data?.purchase || payload?.purchase || {};
  const product = payload?.data?.product || payload?.product || {};

  const nomeCliente = buyer.name || 'Cliente';
  const email       = buyer.email;
  const whatsapp    = buyer.phone || '';
  const plano       = product.name || 'Profissional';
  const valor       = purchase.price?.value ? String(purchase.price.value) : '';

  if (!email) {
    return { statusCode: 400, body: 'E-mail do comprador não encontrado' };
  }

  try {
    const db = getDb();

    // Verifica se já existe cliente com esse e-mail (evita duplicata)
    const existing = await db.collection('clientes').where('email', '==', email).get();
    if (!existing.empty) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'Cliente já existe' }) };
    }

    // Gera código único
    let codigo, existe = true;
    while (existe) {
      codigo = gerarCodigo();
      const check = await db.collection('clientes').doc(codigo).get();
      existe = check.exists;
    }

    // Define vencimento (30 dias padrão — ajuste conforme seu plano)
    const dias = 30;
    const expiraEm = new Date();
    expiraEm.setDate(expiraEm.getDate() + dias);

    // Salva no Firebase
    await db.collection('clientes').doc(codigo).set({
      nome: nomeCliente,
      email,
      whatsapp,
      plano,
      valor,
      pagamento: 'Hotmart',
      empresa: '',
      obs: `Gerado automaticamente via Hotmart. Pedido: ${purchase.order_date || ''}`,
      dias,
      bloqueado: false,
      expiraEm: Timestamp.fromDate(expiraEm),
      criadoEm: FieldValue.serverTimestamp(),
    });

    // Envia e-mail
    await enviarEmail(email, nomeCliente, codigo, expiraEm);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, codigo, email }),
    };

  } catch (err) {
    console.error('Erro webhook:', err);
    return { statusCode: 500, body: 'Erro interno: ' + err.message };
  }
};
