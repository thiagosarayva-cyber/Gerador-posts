const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

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

function gerarCodigo() {
  const letra = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const nums  = Math.floor(1000000 + Math.random() * 9000000).toString();
  return letra + nums;
}

async function enviarEmail(destinatario, nomeCliente, codigo, expiraEm) {
  const dataExpira = expiraEm.toLocaleDateString('pt-BR');
  const appUrl = process.env.APP_URL || 'https://cheery-kelpie-cad8886.netlify.app';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Gerador de Posts <onboarding@resend.dev>',
      to: [destinatario],
      subject: `Seu código de acesso: ${codigo}`,
      html: `<h2>Olá, ${nomeCliente}!</h2><p>Seu acesso está pronto!</p><p><b>Código:</b> ${codigo}</p><p><b>Válido até:</b> ${dataExpira}</p><a href="${appUrl}">Acessar o App</a>`,
    }),
  });
  return res.ok;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const hottok = event.headers['x-hotmart-hottok'] || event.headers['hottok'];
  if (process.env.HOTMART_HOTTOK && hottok !== process.env.HOTMART_HOTTOK) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const event_type = payload?.event || payload?.data?.event;
  const status = payload?.data?.purchase?.status || payload?.purchase?.status;
  const aprovado = event_type === 'PURCHASE_APPROVED' || event_type === 'PURCHASE_COMPLETE' || status === 'APPROVED' || status === 'COMPLETE';

  if (!aprovado) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'Ignorado: ' + event_type }) };
  }

  const buyer = payload?.data?.buyer || payload?.buyer || {};
  const purchase = payload?.data?.purchase || payload?.purchase || {};
  const product = payload?.data?.product || payload?.product || {};

  const nomeCliente = buyer.name || 'Cliente';
  const email = buyer.email;
  const whatsapp = buyer.phone || '';
  const plano = product.name || 'Profissional';
  const valor = purchase.price?.value ? String(purchase.price.value) : '';

  if (!email) return { statusCode: 400, body: 'Email não encontrado' };

  try {
    const db = getDb();

    const existing = await db.collection('clientes').where('email', '==', email).get();
    if (!existing.empty) return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'Cliente já existe' }) };

    let codigo, existe = true;
    while (existe) {
      codigo = gerarCodigo();
      const check = await db.collection('clientes').doc(codigo).get();
      existe = check.exists;
    }

    const dias = 30;
    const expiraEm = new Date();
    expiraEm.setDate(expiraEm.getDate() + dias);

    await db.collection('clientes').doc(codigo).set({
      nome: nomeCliente, email, whatsapp, plano, valor,
      pagamento: 'Hotmart', empresa: '',
      obs: `Gerado via Hotmart.`,
      dias, bloqueado: false,
      expiraEm: Timestamp.fromDate(expiraEm),
      criadoEm: FieldValue.serverTimestamp(),
    });

    await enviarEmail(email, nomeCliente, codigo, expiraEm);

    return { statusCode: 200, body: JSON.stringify({ ok: true, codigo, email }) };

  } catch (err) {
    return { statusCode: 500, body: 'Erro: ' + err.message };
  }
};
