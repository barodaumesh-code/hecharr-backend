// ============================================================
// HECHARR Backend v2 — Production Ready
// Stripe PaymentIntents + Supabase Auth + Orders + Multi-Currency
// Deploy on Railway
// ============================================================

const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ===== CORS =====
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowed =
      origin.endsWith('.netlify.app') ||
      origin.endsWith('.hechar.com') ||
      origin === 'https://hechar.com' ||
      origin === 'http://localhost:3000' ||
      origin === 'http://localhost:5500' ||
      origin === 'http://127.0.0.1:5500' ||
      origin === 'http://127.0.0.1:3000';
    if (allowed) return callback(null, true);
    console.warn('CORS blocked origin:', origin);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));

// Webhook raw body MUST be before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ===== SUPABASE (service role — full access) =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Stripe-supported currencies (add more as needed)
const STRIPE_SUPPORTED = [
  'USD','GBP','EUR','AUD','CAD','SGD','AED','INR',
  'MYR','THB','PHP','HKD','NZD','CHF','SEK','NOK',
  'DKK','JPY','BRL','MXN','ZAR'
];

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({
    message: '🍬 HECHARR Backend v2 is live!',
    status: 'ok',
    timestamp: new Date().toISOString(),
    stripe: process.env.STRIPE_SECRET_KEY ? '✅' : '❌ MISSING',
    supabase: process.env.SUPABASE_URL ? '✅' : '❌ MISSING'
  });
});

// ===== CONFIG (expose publishable key safely) =====
app.get('/config', (req, res) => {
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: 'STRIPE_PUBLISHABLE_KEY not set on server' });
  }
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ===== CREATE PAYMENT INTENT =====
// Frontend sends: { amount (integer cents/subunits), currency, customer, items }
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, customer, items } = req.body;

    if (!amount || isNaN(amount) || amount < 50) {
      return res.status(400).json({ error: 'Invalid amount. Minimum is $0.50 equivalent.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmail = customer?.email && emailRegex.test(customer.email) ? customer.email : null;

    const rawCurrency = (currency || 'USD').toUpperCase();
    // Fall back to USD if currency not supported by Stripe
    const stripeCurrency = STRIPE_SUPPORTED.includes(rawCurrency) ? rawCurrency : 'USD';

    const idempotencyKey = `pi-${(validEmail || 'guest').replace(/[^a-z0-9]/gi,'-')}-${Math.round(amount)}-${stripeCurrency}-${Date.now()}-${Math.random().toString(36).substr(2,6)}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: stripeCurrency.toLowerCase(),
      metadata: {
        customer_email: validEmail || '',
        customer_name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
        item_count: String(items?.length || 0),
        display_currency: rawCurrency,
      },
      description: 'HECHARR Multivitamin Gummies Order',
      receipt_email: validEmail || undefined,
      automatic_payment_methods: { enabled: true }
    }, { idempotencyKey });

    console.log(`✅ PaymentIntent created: ${paymentIntent.id} — ${Math.round(amount)} ${stripeCurrency}`);
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (err) {
    console.error('❌ Stripe PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== SAVE ORDER =====
app.post('/save-order', async (req, res) => {
  try {
    const { paymentIntentId, customer, items, total, currency, authUserId } = req.body;

    if (!paymentIntentId || !customer?.email) {
      return res.status(400).json({ error: 'Missing required order fields.' });
    }

    // Verify payment succeeded with Stripe before saving anything
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment not completed. Status: ${paymentIntent.status}` });
    }

    // Upsert into public users table
    let userId = null;
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', customer.email)
      .maybeSingle();

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: newUser, error: userError } = await supabase
        .from('users')
        .insert({
          auth_user_id: authUserId || null,
          email: customer.email,
          first_name: customer.firstName || '',
          last_name: customer.lastName || '',
          phone: customer.phone || null,
        })
        .select('id')
        .single();
      if (userError) console.error('User insert error:', userError.message);
      userId = newUser?.id || null;
    }

    // Generate unique order ID
    const orderId = 'HCH' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 3).toUpperCase();

    const { error: orderError } = await supabase
      .from('orders')
      .insert({
        order_id: orderId,
        stripe_payment_intent_id: paymentIntentId,
        user_id: userId,
        customer_email: customer.email,
        customer_name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
        customer_phone: customer.phone || null,
        shipping_address: customer.address || '',
        shipping_address2: customer.address2 || null,
        shipping_city: customer.city || '',
        shipping_zip: customer.zip || '',
        shipping_state: customer.state || '',
        shipping_country: customer.country || '',
        items: items,
        total_amount: total,
        currency: (currency || 'USD').toUpperCase(),
        status: 'paid',
      });

    if (orderError) throw orderError;

    console.log(`✅ Order saved: ${orderId} — ${customer.email} — ${total} ${currency}`);
    res.json({ success: true, orderId });
  } catch (err) {
    console.error('❌ Save order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTH: SIGN UP (with auto-login) =====
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,   // auto-confirm — no email verification step
      user_metadata: { first_name: firstName, last_name: lastName }
    });

    if (error) {
      if (error.message.toLowerCase().includes('already')) {
        return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
      }
      return res.status(400).json({ error: error.message });
    }

    // Sync to public users table
    await supabase.from('users').upsert({
      auth_user_id: data.user.id,
      email,
      first_name: firstName || '',
      last_name: lastName || '',
    }, { onConflict: 'email' });

    // Auto-login: sign in immediately after signup to get a session token
    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({ email, password });

    const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

    if (loginError || !loginData.session) {
      // Signup succeeded but auto-login failed — user can manually log in
      console.warn('Auto-login after signup failed:', loginError?.message);
      return res.json({
        success: true,
        user: { id: data.user.id, email, name, firstName, lastName, phone: '' },
        session: null  // frontend will handle gracefully
      });
    }

    res.json({
      success: true,
      user: { id: data.user.id, email, name, firstName, lastName, phone: '' },
      session: {
        access_token:  loginData.session.access_token,
        refresh_token: loginData.session.refresh_token,
        expires_at:    loginData.session.expires_at
      }
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTH: LOGIN =====
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const { data: profile } = await supabase
      .from('users')
      .select('first_name, last_name, phone')
      .eq('email', email)
      .maybeSingle();

    const firstName = profile?.first_name || data.user.user_metadata?.first_name || '';
    const lastName  = profile?.last_name  || data.user.user_metadata?.last_name  || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

    res.json({
      success: true,
      user: { id: data.user.id, email, name, firstName, lastName, phone: profile?.phone || '' },
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== MY ORDERS (authenticated) =====
app.get('/my-orders', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });

    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_email', user.email)
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;
    res.json({ success: true, orders: orders || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN DASHBOARD =====
app.get('/admin', async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:60px;background:#FFF8F0;text-align:center">
      <h2 style="color:#FF6B47;font-size:32px">🔒 Access Denied</h2>
      <p style="color:#8B5A2B;margin-top:12px">Add <code style="background:#f5e6d3;padding:2px 8px;border-radius:4px">?secret=YOUR_ADMIN_SECRET</code> to the URL.</p>
    </body></html>`);
  }

  const { data: orders } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(500);
  const { data: users }  = await supabase.from('users').select('*').order('created_at', { ascending: false }).limit(500);

  const totalRevenue = (orders || []).reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0);
  const avgOrder = orders?.length ? (totalRevenue / orders.length).toFixed(2) : '0.00';
  const statusColors = { paid:'#4CAF50', shipped:'#2196F3', delivered:'#9C27B0', refunded:'#FF5722', pending:'#FF9800' };

  const orderRows = (orders || []).map(o => {
    let itemsText = '-';
    try {
      const parsed = Array.isArray(o.items) ? o.items : JSON.parse(o.items || '[]');
      itemsText = parsed.map(i => `${i.name} ×${i.qty}`).join(', ');
    } catch(e) {}
    const addr = [o.shipping_address, o.shipping_city, o.shipping_state, o.shipping_zip, o.shipping_country].filter(Boolean).join(', ') || '-';
    const c = statusColors[o.status] || '#999';
    return `<tr>
      <td><span class="oid">${o.order_id}</span></td>
      <td>${new Date(o.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td>
      <td>${o.customer_name||'-'}</td><td>${o.customer_email||'-'}</td>
      <td>${o.customer_phone||'-'}</td>
      <td class="sm">${itemsText}</td><td class="sm">${addr}</td>
      <td class="tot">${parseFloat(o.total_amount||0).toFixed(2)} ${o.currency||'USD'}</td>
      <td><span class="badge" style="background:${c}22;color:${c}">${o.status}</span></td>
    </tr>`;
  }).join('');

  const userRows = (users||[]).map(u=>`<tr>
    <td>${[u.first_name,u.last_name].filter(Boolean).join(' ')||'-'}</td>
    <td>${u.email}</td><td>${u.phone||'-'}</td>
    <td>${new Date(u.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td>
  </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HECHARR Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FFF8F0;min-height:100vh}
.hdr{background:linear-gradient(135deg,#FF6B47,#FF9A6C);color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 4px 20px rgba(255,107,71,0.25)}
.hdr h1{font-size:22px;font-weight:800}.hdr-sub{font-size:12px;opacity:.8;margin-top:2px}.hdr-right{font-size:12px;opacity:.8}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px 32px}
.stat{background:white;border-radius:16px;padding:22px 24px;box-shadow:0 2px 12px rgba(255,107,71,.07);border:1px solid rgba(255,107,71,.08)}
.stat-label{font-size:11px;color:#8B5A2B;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px}
.stat-value{font-size:34px;font-weight:800;color:#FF6B47;line-height:1}
.tabs{display:flex;margin:0 32px;border-bottom:2px solid rgba(255,107,71,.12)}
.tab{padding:12px 24px;font-size:14px;font-weight:600;color:#8B5A2B;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .2s}
.tab.active{color:#FF6B47;border-bottom-color:#FF6B47}
.sec{padding:24px 32px;display:none}.sec.active{display:block}
.toolbar{display:flex;gap:12px;margin-bottom:16px;align-items:center}
.search{flex:1;padding:10px 16px;border:1.5px solid rgba(255,107,71,.18);border-radius:10px;font-size:14px;outline:none;font-family:inherit;background:white}
.search:focus{border-color:#FF6B47;box-shadow:0 0 0 3px rgba(255,107,71,.1)}
.btn{background:#FF6B47;color:white;border:none;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer}
.btn:hover{background:#3D1F00}
.wrap{overflow-x:auto;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.06)}
table{width:100%;border-collapse:collapse;background:white;min-width:900px}
th{background:#FF6B47;color:white;padding:12px 14px;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:700;white-space:nowrap}
td{padding:13px 14px;font-size:13px;border-bottom:1px solid #f5e6d3;color:#3D1F00;vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:#FFFAF7}
.badge{padding:4px 10px;border-radius:50px;font-size:11px;font-weight:700;text-transform:capitalize}
.oid{font-family:monospace;font-weight:700;font-size:12px;background:#FFF3EB;color:#FF6B47;padding:3px 8px;border-radius:6px}
.tot{font-weight:700;color:#FF6B47}.sm{font-size:11px;color:#8B5A2B;max-width:180px}
.empty{text-align:center;padding:60px;color:#8B5A2B;font-size:14px}
</style></head><body>
<div class="hdr"><div><h1>🍬 HECHARR Admin</h1><div class="hdr-sub">Orders & Customer Dashboard</div></div>
<div class="hdr-right">Refreshed: ${new Date().toLocaleString('en-GB')}</div></div>
<div class="stats">
  <div class="stat"><div class="stat-label">Total Orders</div><div class="stat-value">${(orders||[]).length}</div></div>
  <div class="stat"><div class="stat-label">Revenue (USD equiv.)</div><div class="stat-value">$${totalRevenue.toFixed(2)}</div></div>
  <div class="stat"><div class="stat-label">Customers</div><div class="stat-value" style="color:#4CAF50">${(users||[]).length}</div></div>
  <div class="stat"><div class="stat-label">Avg Order</div><div class="stat-value">$${avgOrder}</div></div>
</div>
<div class="tabs">
  <div class="tab active" onclick="show('os','cs',this)">📦 Orders (${(orders||[]).length})</div>
  <div class="tab" onclick="show('cs','os',this)">👥 Customers (${(users||[]).length})</div>
</div>
<div id="os" class="sec active">
  <div class="toolbar">
    <input class="search" placeholder="🔍 Search orders..." oninput="filter(this,'ot')">
    <button class="btn" onclick="exportCSV('os','orders')">⬇ Export CSV</button>
    <button class="btn" style="background:#3D1F00" onclick="location.reload()">↺ Refresh</button>
  </div>
  <div class="wrap"><table><thead><tr><th>Order ID</th><th>Date</th><th>Customer</th><th>Email</th><th>Phone</th><th>Items</th><th>Address</th><th>Total</th><th>Status</th></tr></thead>
  <tbody id="ot">${orderRows||'<tr><td colspan="9" class="empty">No orders yet 🛒</td></tr>'}</tbody></table></div>
</div>
<div id="cs" class="sec">
  <div class="toolbar">
    <input class="search" placeholder="🔍 Search customers..." oninput="filter(this,'ct')">
    <button class="btn" onclick="exportCSV('cs','customers')">⬇ Export CSV</button>
  </div>
  <div class="wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Joined</th></tr></thead>
  <tbody id="ct">${userRows||'<tr><td colspan="4" class="empty">No customers yet 👤</td></tr>'}</tbody></table></div>
</div>
<script>
function show(a,b,tab){document.getElementById(a).classList.add('active');document.getElementById(b).classList.remove('active');document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');}
function filter(input,id){const q=input.value.toLowerCase();document.querySelectorAll('#'+id+' tr').forEach(r=>{r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';});}
function exportCSV(secId,name){const t=document.getElementById(secId).querySelector('table');const rows=[...t.querySelectorAll('tr')].map(r=>[...r.querySelectorAll('th,td')].map(c=>'"'+c.innerText.replace(/"/g,'""').trim()+'"').join(','));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([rows.join('\n')],{type:'text/csv'}));a.download='hecharr-'+name+'-'+new Date().toISOString().slice(0,10)+'.csv';a.click();}
</script></body></html>`);
});

// ===== CREATE SUBSCRIPTION (Stripe Checkout Session in subscription mode) =====
app.post('/create-subscription', async (req, res) => {
  try {
    const { priceId, customer, successUrl, cancelUrl } = req.body;

    if (!priceId) return res.status(400).json({ error: 'Missing Stripe Price ID.' });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmail = customer?.email && emailRegex.test(customer.email) ? customer.email : null;

    // Find or create Stripe Customer
    let stripeCustomer;
    if (validEmail) {
      const existing = await stripe.customers.list({ email: validEmail, limit: 1 });
      if (existing.data.length > 0) {
        stripeCustomer = existing.data[0];
      } else {
        stripeCustomer = await stripe.customers.create({
          email: validEmail,
          name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || undefined,
          phone: customer?.phone || undefined,
          address: customer?.address ? {
            line1: customer.address,
            line2: customer.address2 || undefined,
            city: customer.city || undefined,
            postal_code: customer.zip || undefined,
            state: customer.state || undefined,
            country: customer.countryCode || 'US',
          } : undefined,
        });
      }
    }

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || 'https://hechar.com?subscription=success',
      cancel_url: cancelUrl || 'https://hechar.com?subscription=cancelled',
      metadata: {
        customer_email: validEmail || '',
        customer_name: `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim(),
      },
    };

    if (stripeCustomer) {
      sessionParams.customer = stripeCustomer.id;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`✅ Subscription session created: ${session.id}`);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('❌ Subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== GET SUBSCRIPTION STATUS =====
app.post('/subscription-status', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) {
      return res.json({ active: false, subscriptions: [] });
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: 'all',
      limit: 10,
    });

    const activeSubs = subscriptions.data.filter(s => ['active', 'trialing'].includes(s.status));

    res.json({
      active: activeSubs.length > 0,
      subscriptions: subscriptions.data.map(s => ({
        id: s.id,
        status: s.status,
        priceId: s.items.data[0]?.price?.id,
        amount: s.items.data[0]?.price?.unit_amount,
        currency: s.items.data[0]?.price?.currency,
        interval: s.items.data[0]?.price?.recurring?.interval,
        currentPeriodEnd: new Date(s.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: s.cancel_at_period_end,
      })),
    });
  } catch (err) {
    console.error('Subscription status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== CANCEL SUBSCRIPTION =====
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) return res.status(400).json({ error: 'Subscription ID required.' });

    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    console.log(`✅ Subscription ${subscriptionId} set to cancel at period end`);
    res.json({
      success: true,
      cancelAt: new Date(subscription.current_period_end * 1000).toISOString(),
    });
  } catch (err) {
    console.error('Cancel subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== STRIPE WEBHOOK =====
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET is not set — rejecting webhook');
    return res.status(500).send('Webhook secret not configured');
  }
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log(`✅ Webhook: Payment succeeded ${event.data.object.id}`); break;
    case 'payment_intent.payment_failed':
      console.log(`❌ Webhook: Payment failed ${event.data.object.id}`); break;
    // Subscription events
    case 'customer.subscription.created':
      console.log(`✅ Webhook: Subscription created ${event.data.object.id} — Status: ${event.data.object.status}`);
      break;
    case 'customer.subscription.updated':
      console.log(`🔄 Webhook: Subscription updated ${event.data.object.id} — Status: ${event.data.object.status}`);
      break;
    case 'customer.subscription.deleted':
      console.log(`❌ Webhook: Subscription cancelled ${event.data.object.id}`);
      break;
    case 'invoice.paid':
      console.log(`✅ Webhook: Invoice paid ${event.data.object.id} — Subscription: ${event.data.object.subscription}`);
      // Save recurring order to Supabase
      try {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const orderId = 'HSUB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 3).toUpperCase();
          const customerEmail = invoice.customer_email || '';
          
          // Upsert user
          let userId = null;
          if (customerEmail) {
            const { data: existingUser } = await supabase
              .from('users')
              .select('id')
              .eq('email', customerEmail)
              .maybeSingle();
            userId = existingUser?.id || null;
          }

          await supabase.from('orders').insert({
            order_id: orderId,
            stripe_payment_intent_id: invoice.payment_intent,
            user_id: userId,
            customer_email: customerEmail,
            customer_name: invoice.customer_name || '',
            items: [{ name: 'Subscription Renewal', qty: 1, price: invoice.amount_paid / 100 }],
            total_amount: invoice.amount_paid / 100,
            currency: (invoice.currency || 'usd').toUpperCase(),
            status: 'paid',
          });
          console.log(`✅ Subscription order saved: ${orderId}`);
        }
      } catch (saveErr) {
        console.error('Failed to save subscription order:', saveErr.message);
      }
      break;
    case 'invoice.payment_failed':
      console.log(`❌ Webhook: Invoice payment failed ${event.data.object.id}`);
      break;
    case 'checkout.session.completed':
      console.log(`✅ Webhook: Checkout session completed ${event.data.object.id} — Mode: ${event.data.object.mode}`);
      // Save the first order for new subscriptions (renewals are handled by invoice.paid)
      if (event.data.object.mode === 'subscription') {
        try {
          const session = event.data.object;
          const customerEmail = session.customer_details?.email || session.customer_email || '';
          const orderId = 'HCSUB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 3).toUpperCase();

          let userId = null;
          if (customerEmail) {
            const { data: existingUser } = await supabase
              .from('users')
              .select('id')
              .eq('email', customerEmail)
              .maybeSingle();
            userId = existingUser?.id || null;
          }

          await supabase.from('orders').insert({
            order_id: orderId,
            stripe_payment_intent_id: session.payment_intent || session.id,
            user_id: userId,
            customer_email: customerEmail,
            customer_name: session.customer_details?.name || '',
            items: [{ name: 'Subscription — First Order', qty: 1, price: (session.amount_total || 0) / 100 }],
            total_amount: (session.amount_total || 0) / 100,
            currency: (session.currency || 'usd').toUpperCase(),
            status: 'paid',
          });
          console.log(`✅ Subscription first-order saved: ${orderId}`);
        } catch (saveErr) {
          console.error('Failed to save subscription first order:', saveErr.message);
        }
      }
      break;
    default:
      console.log(`Webhook: ${event.type}`);
  }
  res.json({ received: true });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🍬 HECHARR Backend v2 running on port ${PORT}`);
  console.log(`   Stripe SK:  ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌ MISSING'}`);
  console.log(`   Stripe PK:  ${process.env.STRIPE_PUBLISHABLE_KEY ? '✅' : '❌ MISSING — set STRIPE_PUBLISHABLE_KEY'}`);
  console.log(`   Stripe WHK: ${process.env.STRIPE_WEBHOOK_SECRET ? '✅' : '❌ MISSING — set STRIPE_WEBHOOK_SECRET'}`);
  console.log(`   Supabase:   ${process.env.SUPABASE_URL ? '✅' : '❌ MISSING'}`);
  console.log(`   Admin:      ${process.env.ADMIN_SECRET ? '✅' : '⚠️  set ADMIN_SECRET'}\n`);
});
