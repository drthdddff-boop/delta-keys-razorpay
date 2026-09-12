const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, '.data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

function env(...names) {
  for (const name of names) {
    const v = String(process.env[name] || '').trim();
    if (v) return v;
  }
  return '';
}
function razorKeyId(){ return env('RAZORPAY_KEY_ID','RAZORPAY_KEY','RAZORPAY_PUBLIC_KEY'); }
function razorSecret(){ return env('RAZORPAY_KEY_SECRET','RAZORPAY_SECRET'); }
function razorConfigured(){ return !!(razorKeyId() && razorSecret()); }

function ensureData(){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  if(!fs.existsSync(STORE_FILE)) writeJson(STORE_FILE,{settings:{storeName:process.env.STORE_NAME||'DELTA.KEYS',currency:'INR'},products:[
    {id:'prod_delta',name:'DELTA SERVER',description:'Premium access key with instant delivery.',active:true},
    {id:'prod_vip',name:'DELTA VIP',description:'VIP access with extended validity.',active:true}
  ],plans:[
    {id:'plan_7d',productId:'prod_delta',name:'7 DAYS',price:200,active:true},
    {id:'plan_30d',productId:'prod_delta',name:'30 DAYS',price:600,active:true},
    {id:'plan_90d',productId:'prod_delta',name:'90 DAYS',price:899,active:true},
    {id:'plan_vip30',productId:'prod_vip',name:'VIP 30 DAYS',price:699,active:true}
  ],keys:[],orders:[]});
  if(!fs.existsSync(SESSION_FILE)) writeJson(SESSION_FILE,{});
}
function readJson(f){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}}
function writeJson(f,d){const t=f+'.tmp';fs.writeFileSync(t,JSON.stringify(d,null,2));fs.renameSync(t,f);}
function store(){return readJson(STORE_FILE);}
function saveStore(d){writeJson(STORE_FILE,d);}
function sessions(){return readJson(SESSION_FILE)||{};}
function saveSessions(d){writeJson(SESSION_FILE,d);}
function id(p){return p+'_'+crypto.randomBytes(6).toString('hex');}
function now(){return new Date().toISOString();}
function safeEqual(a,b){const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);}

function adminAuth(req,res,next){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const s=sessions()[token];
  if(!s||s.expiresAt<Date.now()) return res.status(401).json({error:'Admin authentication required.'});
  next();
}

async function razorpayRequest(endpoint,method='GET',body=null){
  const keyId=razorKeyId(), secret=razorSecret();
  if(!keyId||!secret) throw new Error('Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Railway Variables.');
  const auth=Buffer.from(`${keyId}:${secret}`).toString('base64');
  const r=await fetch(`https://api.razorpay.com/v1${endpoint}`,{method,headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const text=await r.text(); let data={}; try{data=JSON.parse(text);}catch{}
  if(!r.ok) throw new Error(data?.error?.description||data?.error?.reason||`Razorpay API error (${r.status})`);
  return data;
}

function publicOrder(db,o){
  const p=db.products.find(x=>x.id===o.productId), plan=db.plans.find(x=>x.id===o.planId);
  const {customerToken,...safe}=o;
  return {...safe,productName:p?.name||'Unknown',planName:plan?.name||'Unknown'};
}
function deliverOrder(db,o){
  if(o.status==='paid'&&Array.isArray(o.keys)&&o.keys.length)return true;
  const a=db.keys.filter(k=>k.productId===o.productId&&k.planId===o.planId&&k.status==='available');
  if(a.length<o.quantity)return false;
  a.slice(0,o.quantity).forEach(k=>{k.status='sold';k.orderId=o.id;k.soldAt=now();});
  o.keys=a.slice(0,o.quantity).map(k=>k.value);o.status='paid';o.paidAt=now();return true;
}
function fulfill(db,o,payment){
  if(Number(payment.amount)!==Math.round(Number(o.amount)*100)||String(payment.currency||'').toUpperCase()!==String(o.currency).toUpperCase())throw new Error('Payment amount or currency does not match the order.');
  if(String(payment.status||'').toLowerCase()!=='captured')throw new Error('Payment is not captured.');
  if(!deliverOrder(db,o))throw new Error('Payment received, but not enough keys are available.');
  o.razorpayPaymentId=payment.id||o.razorpayPaymentId||null;o.paymentVerifiedAt=now();o.paymentSource='razorpay_checkout';
}

ensureData();

app.get('/api/health',(req,res)=>res.json({ok:true,razorpayConfigured:razorConfigured(),keyIdConfigured:!!razorKeyId(),secretConfigured:!!razorSecret()}));
app.get('/api/store',(req,res)=>{
  const db=store();
  res.json({settings:db.settings,products:db.products.filter(p=>p.active).map(p=>({...p,plans:db.plans.filter(x=>x.productId===p.id&&x.active).map(x=>({...x,stock:db.keys.filter(k=>k.productId===p.id&&k.planId===x.id&&k.status==='available').length}))}))});
});

app.post('/api/orders',async(req,res)=>{
  const {planId,quantity=1,email=''}=req.body||{};const qty=Math.max(1,Math.min(10,Number(quantity)||1));const db=store();
  const plan=db.plans.find(p=>p.id===planId&&p.active);if(!plan)return res.status(404).json({error:'Plan not found.'});
  const product=db.products.find(p=>p.id===plan.productId&&p.active);const available=db.keys.filter(k=>k.productId===product.id&&k.planId===plan.id&&k.status==='available').length;
  if(available<qty)return res.status(409).json({error:`Only ${available} key(s) are currently available.`});
  if(!razorConfigured())return res.status(503).json({error:'Razorpay is not configured on this server. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in Railway Variables, then redeploy.'});
  const localOrderId=id('ord'),customerToken=crypto.randomBytes(24).toString('hex');
  let ro;try{ro=await razorpayRequest('/orders','POST',{amount:Math.round(plan.price*qty*100),currency:db.settings.currency,receipt:localOrderId.slice(0,40),notes:{delta_order_id:localOrderId,product_id:product.id,plan_id:plan.id}});}catch(e){return res.status(502).json({error:`Unable to create Razorpay order: ${e.message}`});}
  const order={id:localOrderId,email:String(email).trim().slice(0,160),productId:product.id,planId:plan.id,quantity:qty,amount:plan.price*qty,currency:db.settings.currency,status:'pending_payment',keys:[],customerToken,razorpayOrderId:ro.id,createdAt:now(),paidAt:null};
  db.orders.unshift(order);saveStore(db);
  res.status(201).json({order:publicOrder(db,order),customerToken,razorpay:{keyId:razorKeyId(),orderId:ro.id,amount:ro.amount,currency:ro.currency}});
});

app.post('/api/payment/verify',async(req,res)=>{
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
  if(!razorpay_order_id||!razorpay_payment_id||!razorpay_signature)return res.status(400).json({error:'Incomplete Razorpay payment response.'});
  const db=store(),o=db.orders.find(x=>x.razorpayOrderId===razorpay_order_id);if(!o)return res.status(404).json({error:'Local order not found.'});
  const generated=crypto.createHmac('sha256',razorSecret()).update(`${o.razorpayOrderId}|${razorpay_payment_id}`).digest('hex');
  if(!safeEqual(generated,razorpay_signature))return res.status(401).json({error:'Invalid Razorpay payment signature.'});
  try{const p=await razorpayRequest(`/payments/${encodeURIComponent(razorpay_payment_id)}`);if(p.order_id!==o.razorpayOrderId)return res.status(409).json({error:'Payment belongs to a different order.'});fulfill(db,o,p);saveStore(db);return res.json({ok:true,order:publicOrder(db,o)});}catch(e){return res.status(409).json({error:e.message});}
});

app.get('/api/orders/:id',(req,res)=>{const db=store(),o=db.orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'Order not found.'});const t=String(req.headers['x-order-token']||req.query.token||'');if(!safeEqual(t,o.customerToken))return res.status(401).json({error:'Order access denied.'});res.json({order:publicOrder(db,o)});});

app.post('/api/admin/login',(req,res)=>{const u=env('ADMIN_USER')||'admin',p=env('ADMIN_PASSWORD')||'change-this-password';if(req.body?.username!==u||req.body?.password!==p)return res.status(401).json({error:'Invalid admin credentials.'});const token=crypto.randomBytes(32).toString('hex'),ss=sessions();ss[token]={expiresAt:Date.now()+8*60*60*1000};saveSessions(ss);res.json({token});});
app.post('/api/admin/logout',adminAuth,(req,res)=>{const t=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const ss=sessions();delete ss[t];saveSessions(ss);res.json({ok:true});});
app.get('/api/admin/data',adminAuth,(req,res)=>{const db=store();res.json({settings:db.settings,products:db.products,plans:db.plans,orders:db.orders.map(o=>{const {customerToken,...x}=o;return x;})});});
app.post('/api/admin/keys',adminAuth,(req,res)=>{const productId=String(req.body?.productId||''),planId=String(req.body?.planId||''),values=[...new Set(String(req.body?.keys||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean))],db=store(),plan=db.plans.find(p=>p.id===planId&&p.productId===productId);if(!plan)return res.status(400).json({error:'Product/plan combination is invalid.'});if(!values.length)return res.status(400).json({error:'Paste at least one key.'});const ex=new Set(db.keys.map(k=>k.value));const unique=values.filter(v=>!ex.has(v));unique.forEach(value=>db.keys.push({id:id('key'),productId,planId,value,status:'available',orderId:null,createdAt:now()}));saveStore(db);res.json({added:unique.length,skippedDuplicates:values.length-unique.length});});

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.use(express.static(path.join(__dirname,'public')));
app.listen(PORT,'0.0.0.0',()=>console.log(`DELTA.KEYS running on port ${PORT}; Razorpay configured: ${razorConfigured()}`));
