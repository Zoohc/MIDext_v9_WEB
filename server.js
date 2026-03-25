require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

// ─── Polar SDK ───────────────────────────────────────────────────────────────
const { Polar } = require('@polar-sh/sdk');
const polar = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN || '',
  server: 'production',
});

// ─── Firebase Admin (webhook에서 Firestore 업데이트) ─────────────────────────
let adminDb = null;
try {
  const admin = require('firebase-admin');
  // GOOGLE_APPLICATION_CREDENTIALS 환경변수 또는 서비스 계정 JSON 경로 필요
  // 없으면 webhook 기능 비활성화 (로그인은 클라이언트 SDK로 처리)
  if (!admin.apps.length) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      let credential;
      if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        credential = admin.credential.cert(serviceAccount);
      } else {
        credential = admin.credential.applicationDefault();
      }
      admin.initializeApp({
        credential,
        databaseURL: `https://midext-373e5.firebaseio.com`,
      });
      adminDb = admin.firestore();
      console.log('[Firebase Admin] Initialized successfully');
    } else {
      console.warn('[Firebase Admin] No credentials found — webhook isPro update will be skipped');
    }
  }
} catch (e) {
  console.warn('[Firebase Admin] Init failed:', e.message);
}

// ─── Express 앱 ──────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.use(cors({
  origin: [APP_URL, 'http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
}));

// ─── Polar 웹훅: raw body 필요 ───────────────────────────────────────────────
app.use('/api/webhook/polar', express.raw({ type: 'application/json' }));
// 나머지 라우트는 JSON 파싱
app.use(express.json());

// ─── API: Polar 체크아웃 세션 생성 ───────────────────────────────────────────
app.post('/api/create-polar-checkout', async (req, res) => {
  try {
    const { userId, tier } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const productId =
      tier === 'premium'
        ? process.env.POLAR_PREMIUM_PRODUCT_ID
        : process.env.POLAR_PRO_PRODUCT_ID;

    // Product ID 미설정 시 mock 처리 (개발용)
    if (!productId || productId.startsWith('prod_...')) {
      console.log(`[Mock] Polar checkout for ${tier}`);
      return res.json({
        url: `${APP_URL}/success?checkout_id=demo_${tier}_${Date.now()}`,
      });
    }

    const checkout = await polar.checkouts.create({
      products: [productId],
      successUrl: `${APP_URL}/success?checkout_id={CHECKOUT_ID}`,
      metadata: { userId, tier },
    });

    res.json({ url: checkout.url });
  } catch (error) {
    console.error('[Polar] checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── API: Polar 웹훅 수신 ─────────────────────────────────────────────────────
app.post('/api/webhook/polar', async (req, res) => {
  try {
    const rawBody = req.body;
    const payload = JSON.parse(rawBody.toString('utf8'));
    const eventType = payload.type;
    console.log('[Polar Webhook] event:', eventType);

    // 구독 활성화 이벤트 처리
    if (
      eventType === 'subscription.created' ||
      eventType === 'subscription.updated' ||
      eventType === 'checkout.order_created'
    ) {
      const metadata =
        payload.data?.metadata ||
        payload.data?.checkout?.metadata ||
        {};
      const userId = metadata.userId;

      if (userId && adminDb) {
        await adminDb.collection('users').doc(userId).update({ isPro: true });
        console.log(`[Polar Webhook] User ${userId} upgraded to Pro`);
      } else if (!adminDb) {
        console.warn('[Polar Webhook] adminDb not available — cannot update isPro');
      }
    }

    // 구독 취소/만료 처리
    if (eventType === 'subscription.canceled' || eventType === 'subscription.revoked') {
      const metadata = payload.data?.metadata || {};
      const userId = metadata.userId;
      if (userId && adminDb) {
        await adminDb.collection('users').doc(userId).update({ isPro: false });
        console.log(`[Polar Webhook] User ${userId} downgraded to Free`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Polar Webhook] error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ─── Firebase Auth Handler 프록시 (3rd party cookie 문제 해결) ─────────────────
const FIREBASE_AUTH_DOMAIN = 'midext-373e5.firebaseapp.com';
app.get('/__/auth/*', async (req, res) => {
  try {
    const url = `https://${FIREBASE_AUTH_DOMAIN}${req.originalUrl}`;
    const response = await fetch(url, {
      headers: { 'Accept': req.headers.accept || '*/*' },
    });
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const body = await response.text();
    res.status(response.status).send(body);
  } catch (e) {
    console.error('[Auth Proxy] error:', e.message);
    res.status(502).send('Auth proxy error');
  }
});

// ─── 정적 파일 서빙 ───────────────────────────────────────────────────────────
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// SPA 라우팅 (모든 경로 → index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// ─── 서버 시작 ────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎹 MIDext v9 Server\n   → http://localhost:${PORT}\n   → APP_URL: ${APP_URL}\n`);
});
