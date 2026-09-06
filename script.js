/* ============================================================
   script.js
   Customer-facing storefront logic for index.html:
   accounts (signup/login/OTP) + product browsing, studio
   customizer, cart, checkout, order tracking, my-orders,
   and the hidden 5-click admin-access gate (redirects to
   admin.html on the correct password).

   Load order in index.html:
   config.js -> storage.js -> api.js -> script.js
   ============================================================ */

/* ============================================================
   auth.js
   Customer accounts: signup, login, forgot-password (email OTP),
   and keeping the logged-in state on this device.
   Depends on: config.js, storage.js (must load before this).
   ============================================================ */

let pendingCheckoutAfterAuth = false;
let fpEmailForReset = '';

// ---- Session (this device only — "don't sign up again here") ----
function getCurrentUser(){
  const raw = localStorage.getItem('afs-current-user');
  return raw ? JSON.parse(raw) : null;
}
function setCurrentUser(user){
  localStorage.setItem('afs-current-user', JSON.stringify(user));
}
function clearCurrentUser(){
  localStorage.removeItem('afs-current-user');
}

function updateAuthUI(){
  const area = $('#authArea');
  if(!area) return;
  const user = getCurrentUser();
  if(user){
    area.innerHTML = `<span class="auth-user-chip">Hi, ${(user.name||'').split(' ')[0]||'there'} <button class="auth-logout-btn" id="logoutBtn">Logout</button></span>`;
    $('#logoutBtn').onclick = () => { clearCurrentUser(); updateAuthUI(); };
  } else {
    area.innerHTML = `<button class="auth-open-btn" id="openAuthBtn">Login / Sign Up</button>`;
    $('#openAuthBtn').onclick = () => openAuthModal('login');
  }
}

// ---- Modal open/close + tab & step switching ----
function openAuthModal(tab){
  clearAuthErrors();
  $('#authModal')?.classList.add('open');
  $('#backdrop')?.classList.add('open');
  switchAuthTab(tab || 'login');
}
function closeAuthModal(){
  $('#authModal')?.classList.remove('open');
  $('#backdrop')?.classList.remove('open');
  pendingCheckoutAfterAuth = false;
}
function clearAuthErrors(){
  ['loginError','signupError','fpStep1Error','fpStep2Error'].forEach(id => { const el = document.getElementById(id); if(el) el.textContent=''; });
}
function switchAuthTab(tab){
  clearAuthErrors();
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.authTab === tab));
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
  if(tab === 'login') $('#loginForm')?.classList.add('active');
  if(tab === 'signup') $('#signupForm')?.classList.add('active');
}
function showForgotStep1(){
  clearAuthErrors();
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
  $('#forgotStep1Form')?.classList.add('active');
}
function showForgotStep2(){
  clearAuthErrors();
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
  $('#forgotStep2Form')?.classList.add('active');
}

// ---- Validation helpers ----
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^0\d{10}$/;
const POSTAL_RE = /^\d{4,6}$/;

// ---- Signup ----
// Pending signup data stored here while OTP is being verified
let pendingSignupData = null;

async function handleSignup(e){
  e.preventDefault();
  const name = $('#signupName').value.trim();
  const email = $('#signupEmail').value.trim().toLowerCase();
  const phone = $('#signupPhone').value.trim();
  const citySel = $('#signupCity').value;
  const city = citySel === 'Other' ? $('#signupCityOther').value.trim() : citySel;
  const address = $('#signupAddress').value.trim();
  const postal = $('#signupPostal').value.trim();
  const password = $('#signupPassword').value;
  const confirm = $('#signupConfirmPassword').value;
  const errEl = $('#signupError');

  if(!name || !email || !phone || !city || !address || !postal || !password){ errEl.textContent = 'Sab fields fill karo.'; return; }
  if(!EMAIL_RE.test(email)){ errEl.textContent = 'Email sahi format mein daalo.'; return; }
  if(!PHONE_RE.test(phone)){ errEl.textContent = 'Phone number bilkul 11 digits ka hona chahiye, e.g. 03001234567. Kam ya zyada numbers nahi chalenge.'; return; }
  if(!POSTAL_RE.test(postal)){ errEl.textContent = 'Postal code sahi daalo (4-6 digits).'; return; }
  if(password.length < 6){ errEl.textContent = 'Password kam se kam 6 characters ka ho.'; return; }
  if(password !== confirm){ errEl.textContent = 'Password match nahi ho raha.'; return; }

  const submitBtn = $('#signupForm button[type=submit]');
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Please wait...'; }
  try{
    const existing = await getUserByEmail(email);
    if(existing){ errEl.textContent = 'Ye email pehle se registered hai. Login karo.'; return; }

    // Generate and send OTP
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await saveOtp(email, code);
    await sendOtpEmail(email, name, code);

    // Save pending signup data to complete after OTP verify
    const salt = randomSalt();
    const passwordHash = await hashPassword(password, salt);
    pendingSignupData = { name, email, phone, address, city, postal, salt, passwordHash };

    // Show OTP verification panel
    showSignupOtpStep(email);
  } catch(err){
    console.error('Signup error:', err);
    const detail = err?.text || err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    errEl.textContent = 'Signup nahi ho saka: ' + detail;
  } finally {
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Sign Up →'; }
  }
}

function showSignupOtpStep(email){
  clearAuthErrors();
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
  const panel = $('#signupOtpForm');
  if(panel){
    panel.classList.add('active');
    const hint = panel.querySelector('.signup-otp-hint');
    if(hint) hint.textContent = `OTP bheja gaya: ${email}`;
  }
}

async function handleSignupOtp(e){
  e.preventDefault();
  const errEl = $('#signupOtpError');
  if(!pendingSignupData){ errEl.textContent = 'Session expire ho gaya. Dobara signup karo.'; return; }
  const entered = $('#signupOtpInput').value.trim();
  const { email } = pendingSignupData;

  const submitBtn = $('#signupOtpForm button[type=submit]');
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Verifying...'; }
  try{
    const record = await getOtp(email);
    if(!record){ errEl.textContent = 'OTP nahi mila. Dobara signup karo.'; return; }
    if(Date.now() > record.expiresAt){ errEl.textContent = 'OTP expire ho gaya. Dobara signup karo.'; clearOtp(email); return; }
    if(record.code !== entered){ errEl.textContent = 'OTP galat hai. Dobara check karo.'; return; }

    // OTP correct — create account
    await clearOtp(email);
    const { name, phone, address, city, postal, salt, passwordHash } = pendingSignupData;
    const user = { name, email, phone, address, city, postal, salt, passwordHash, createdAt: new Date().toISOString() };
    await saveUser(user);
    setCurrentUser({ name, email, phone, address, city, postal });
    pendingSignupData = null;
    updateAuthUI();
    const shouldContinueToCheckout = pendingCheckoutAfterAuth;
    closeAuthModal();
    if(shouldContinueToCheckout) openCheckout();
  } catch(err){
    console.error('Signup OTP error:', err);
    errEl.textContent = 'Verification nahi ho saka. Dobara try karo.';
  } finally {
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Verify & Sign Up →'; }
  }
}

// ---- Login ----
async function handleLogin(e){
  e.preventDefault();
  const email = $('#loginEmail').value.trim().toLowerCase();
  const password = $('#loginPassword').value;
  const errEl = $('#loginError');
  if(!email || !password){ errEl.textContent = 'Email aur password dono daalo.'; return; }

  const submitBtn = $('#loginForm button[type=submit]');
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Please wait...'; }
  try{
    const user = await getUserByEmail(email);
    if(!user){ errEl.textContent = 'Account nahi mila. Sign up karo.'; return; }
    const hash = await hashPassword(password, user.salt);
    if(hash !== user.passwordHash){ errEl.textContent = 'Email ya password galat hai.'; return; }
    setCurrentUser({ name:user.name, email:user.email, phone:user.phone, address:user.address, city:user.city, postal:user.postal });
    updateAuthUI();
    const shouldContinueToCheckout = pendingCheckoutAfterAuth;
    closeAuthModal();
    if(shouldContinueToCheckout) openCheckout();
  } catch(err){
    console.error('Login error:', err);
    const detail = err?.text || err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    errEl.textContent = 'Login nahi ho saka: ' + detail;
  } finally {
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Login →'; }
  }
}

// ---- Forgot password: step 1, send OTP ----
async function handleSendOtp(e){
  e.preventDefault();
  const email = $('#fpEmail').value.trim().toLowerCase();
  const errEl = $('#fpStep1Error');
  if(!EMAIL_RE.test(email)){ errEl.textContent = 'Email sahi format mein daalo.'; return; }

  const submitBtn = $('#forgotStep1Form button[type=submit]');
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Sending...'; }
  try{
    const user = await getUserByEmail(email);
    if(!user){ errEl.textContent = 'Ye email registered nahi hai.'; return; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await saveOtp(email, code);
    await sendOtpEmail(email, user.name, code);
    fpEmailForReset = email;
    showForgotStep2();
  } catch(err){
    console.error('OTP send error:', err);
    const detail = err?.text || err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    errEl.textContent = 'OTP email nahi bhej saka: ' + detail;
  } finally {
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Send OTP →'; }
  }
}

// ---- Forgot password: step 2, verify OTP + set new password ----
async function handleResetPassword(e){
  e.preventDefault();
  const enteredCode = $('#fpOtp').value.trim();
  const newPassword = $('#fpNewPassword').value;
  const confirm = $('#fpConfirmPassword').value;
  const errEl = $('#fpStep2Error');
  if(newPassword.length < 6){ errEl.textContent = 'Password kam se kam 6 characters ka ho.'; return; }
  if(newPassword !== confirm){ errEl.textContent = 'Password match nahi ho raha.'; return; }

  const submitBtn = $('#forgotStep2Form button[type=submit]');
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Please wait...'; }
  try{
    const otpRecord = await getOtp(fpEmailForReset);
    if(!otpRecord || otpRecord.code !== enteredCode){ errEl.textContent = 'OTP galat hai.'; return; }
    if(Date.now() > otpRecord.expiresAt){ errEl.textContent = 'OTP expire ho gaya. Dobara bhejo.'; return; }
    const salt = randomSalt();
    const passwordHash = await hashPassword(newPassword, salt);
    await updateUserFields(fpEmailForReset, { passwordHash, salt });
    await clearOtp(fpEmailForReset);
    switchAuthTab('login');
    $('#loginEmail').value = fpEmailForReset;
    $('#loginError').textContent = 'Password change ho gaya — ab login karo.';
  } catch(err){
    console.error('Reset password error:', err);
    const detail = err?.text || err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
    errEl.textContent = 'Kuch ghalat ho gaya: ' + detail;
  } finally {
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Reset password →'; }
  }
}

function wireAuthModal(){
  document.querySelectorAll('.auth-tab').forEach(t => t.onclick = () => switchAuthTab(t.dataset.authTab));
  $('#loginForm')?.addEventListener('submit', handleLogin);
  $('#signupForm')?.addEventListener('submit', handleSignup);
  $('#signupOtpForm')?.addEventListener('submit', handleSignupOtp);
  $('#forgotStep1Form')?.addEventListener('submit', handleSendOtp);
  $('#forgotStep2Form')?.addEventListener('submit', handleResetPassword);
  $('#forgotPasswordLink')?.addEventListener('click', e => { e.preventDefault(); showForgotStep1(); });
  $('#backToLoginLink')?.addEventListener('click', e => { e.preventDefault(); switchAuthTab('login'); });
  document.querySelector('[data-close-auth]')?.addEventListener('click', closeAuthModal);
  $('#signupCity')?.addEventListener('change', () => {
    $('#signupCityOther').style.display = $('#signupCity').value === 'Other' ? 'block' : 'none';
  });
}


/* ============================================================
   user.js
   Logic for the customer-facing storefront (user.html).
   Load order in the HTML: config.js -> storage.js -> user.js
   ============================================================ */

let products = [];
let selected = null;
let adminSelected = null;
let selections = {};
let cart = getCart();
let orders = [];

function selectedOptions(){
  return selected.groups.map((g,i) => g.options[selections[i]||0]).filter(Boolean);
}

function renderProducts(){
  const grid = $('#productGrid');
  if(!grid) return;
  grid.innerHTML = products.map(p => `<article class="product-card"><img src="${p.image}" alt="${p.name}"><div><small>${p.category} / Made to order</small><h3>${p.name}</h3><p>${p.description}</p><button data-product="${p.id}">Customize & view ↗</button></div></article>`).join('');
  grid.querySelectorAll('button').forEach(b => b.onclick = () => chooseProduct(products.find(p => p.id === b.dataset.product)));
}

function chooseProduct(p){
  selected = p;
  selections = {};
  renderStudio();
  document.getElementById('studio').scrollIntoView({behavior:'smooth'});
}

function renderStudio(){
  if(!$('#selectedName')) return;
  $('#selectedName').textContent = selected.name;
  $('#optionGroups').innerHTML = selected.groups.map((g,gi) => `<div class="option-group"><strong>${String(gi+1).padStart(2,'0')} / ${g.name}</strong><div class="option-list">${g.options.map((o,oi) => `<button class="${(selections[gi]||0)===oi?'active':''}" data-group="${gi}" data-option="${oi}">${o.hex?`<span class="swatch" style="background:${o.hex}"></span>`:''}${o.name}${o.price?` +${money(o.price)}`:''}</button>`).join('')}</div></div>`).join('');
  $('#optionGroups').querySelectorAll('button').forEach(b => b.onclick = () => { selections[+b.dataset.group] = +b.dataset.option; renderStudio(); });

  const opts = selectedOptions();
  const price = selected.price + opts.reduce((a,o) => a + (+o.price||0), 0);
  const color = opts.find(o => o.hex)?.hex || 'transparent';
  const replacement = opts.find(o => o.image)?.image;

  $('#selectedPrice').textContent = money(price);
  $('#addPrice').textContent = money(price);
  $('#previewImage').src = replacement || selected.image;
  $('#previewImage').alt = selected.name + ' preview';

  const img = $('#previewImage');
  $('#previewTint').style.background = 'transparent';
  $('#previewTint').style.opacity = '0';

  if(color === 'transparent'){
    if(img) img.style.filter = 'none';
  } else {
    // Brown leather base = roughly hue 25deg, sepia(1) gives ~37deg
    // We need to rotate FROM that base TO target hue
    const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
    let targetHue = 0;
    if(d !== 0){
      if(max === r) targetHue = ((g-b)/d) % 6;
      else if(max === g) targetHue = (b-r)/d + 2;
      else targetHue = (r-g)/d + 4;
      targetHue = Math.round(targetHue * 60);
      if(targetHue < 0) targetHue += 360;
    }
    // sepia() produces hue ~37deg. Rotate from 37 to target.
    const rotate = targetHue - 37;
    // Saturation: grey/black = low, vivid = high
    const sat = d === 0 ? 0 : Math.round((d/max) * 180);
    // Brightness: dark colors need less brightness
    const lum = (r*0.299 + g*0.587 + b*0.114) / 255;
    const bri = Math.max(0.3, Math.min(1.1, lum*1.4));
    // Black/very dark: just desaturate + darken, no hue rotate needed
    if(lum < 0.12){
      if(img) img.style.filter = `grayscale(1) brightness(${(lum*3).toFixed(2)}) contrast(1.1)`;
    } else if(d/max < 0.15){
      // Near grey/neutral: sepia + slight rotate + low sat
      if(img) img.style.filter = `sepia(1) hue-rotate(${rotate}deg) saturate(0.4) brightness(${bri.toFixed(2)})`;
    } else {
      // Full color leather
      if(img) img.style.filter = `sepia(1) hue-rotate(${rotate}deg) saturate(${(sat/60).toFixed(2)}) brightness(${bri.toFixed(2)})`;
    }
  }
}

function renderCart(){
  const box = $('#cartItems');
  if(!box) return;
  $('#cartCount').textContent = String(cart.length).padStart(2,'0');
  box.innerHTML = cart.length ? cart.map((i,n) => `<div class="cart-row"><img src="${i.image}" alt="${i.name}"><div><strong>${i.name}</strong><small>${i.options.join(' · ')||'Standard finish'}<br>${money(i.price)}</small></div><button class="close" data-remove="${n}">×</button></div>`).join('') : '<p>Your bag is empty. Choose a piece from the collection.</p>';
  cart.forEach((_,n) => box.querySelector(`[data-remove="${n}"]`)?.addEventListener('click', () => { cart.splice(n,1); saveCart(); }));
  $('#cartTotal').textContent = money(cart.reduce((a,i) => a + i.price, 0));
}

function saveCart(){
  saveCartData(cart);
  renderCart();
}

function openCart(){ renderCart(); $('#cartDrawer').classList.add('open'); $('#backdrop').classList.add('open'); }
function closeCart(){ $('#cartDrawer').classList.remove('open'); $('#backdrop').classList.remove('open'); }

function addCurrent(){
  const opts = selectedOptions();
  cart.push({
    name: selected.name,
    image: selected.image,
    price: selected.price + opts.reduce((a,o) => a + (+o.price||0), 0),
    options: opts.map(o => o.name)
  });
  saveCart();
  openCart();
}

function openCheckout(){
  if(!cart.length) return alert('Your bag is empty.');
  const user = getCurrentUser();
  if(!user){
    closeCart();
    pendingCheckoutAfterAuth = true;
    openAuthModal('signup');
    return;
  }
  closeCart();
  $('#customerName').value = user.name || '';
  $('#customerPhone').value = user.phone || '';
  $('#customerAddress').value = user.address || '';
  $('#customerPostal').value = user.postal || '';
  $('#checkoutModal').classList.add('open');
  $('#backdrop').classList.add('open');
}
function closeCheckout(){ $('#checkoutModal').classList.remove('open'); $('#backdrop').classList.remove('open'); }

function renderMyOrders(){
  const box = $('#myOrdersList');
  if(!box) return;
  const user = getCurrentUser();
  const mine = user ? orders.filter(o => o.customerEmail === user.email) : [];
  if(!mine.length){
    box.innerHTML = `<div class="no-orders-msg">
      <span class="no-orders-icon">🛍</span>
      <strong>Koi order nahi abhi tak</strong>
      <p>Collection se apna piece choose karo<br>aur customize karke order karo.</p>
    </div>`;
    return;
  }
  const statusDot = {'Pending acceptance':'⏳','Accepted':'✅','Shipped':'🚚','Delivered':'📦','Cancelled':'❌'};
  box.innerHTML = [...mine].reverse().map(o => {
    const sc = statusColor(o.status);
    const date = new Date(o.createdAt).toLocaleDateString('en-PK', {day:'numeric',month:'short',year:'numeric'});
    return `<div class="my-order-card status-${sc}">
      <div class="my-order-card-accent"></div>
      <div class="my-order-card-inner">
        <div class="my-order-card-head">
          <div>
            <div class="my-order-id">${o.id}</div>
            <div class="my-order-date">${date} · ${o.payment||'COD'}</div>
          </div>
          <div class="my-order-status-badge">${statusDot[o.status]||'⏳'} ${o.status}</div>
        </div>
        <div class="my-order-divider"></div>
        <div class
