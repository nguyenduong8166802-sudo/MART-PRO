const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const methodOverride = require('method-override');

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'duongmartpro';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(methodOverride('_method'));

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

function formatMoney(v) {
  return new Intl.NumberFormat('vi-VN').format(Number(v || 0)) + 'đ';
}

async function query(sql, params = []) { return pool.query(sql, params); }

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(120) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'buyer',
      seller_name VARCHAR(150),
      referral_code VARCHAR(80),
      parent_id INT,
      wallet_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      referral_rate NUMERIC(5,2) NOT NULL DEFAULT 20,
      commission_rate NUMERIC(5,2) NOT NULL DEFAULT 20,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      seller_id INT REFERENCES users(id) ON DELETE SET NULL,
      name VARCHAR(180) NOT NULL,
      description TEXT,
      price NUMERIC(18,2) NOT NULL DEFAULT 0,
      sale_price NUMERIC(18,2),
      stock INT NOT NULL DEFAULT 0,
      image_url TEXT,
      is_visible BOOLEAN NOT NULL DEFAULT true,
      is_featured BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      buyer_id INT REFERENCES users(id) ON DELETE SET NULL,
      seller_id INT REFERENCES users(id) ON DELETE SET NULL,
      total NUMERIC(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      product_id INT REFERENCES products(id) ON DELETE SET NULL,
      product_name VARCHAR(180) NOT NULL,
      price NUMERIC(18,2) NOT NULL DEFAULT 0,
      qty INT NOT NULL DEFAULT 1,
      image_url TEXT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(18,2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS site_marketing (
      id SERIAL PRIMARY KEY,
      top_banner TEXT,
      hero_badge TEXT,
      hero_title TEXT,
      hero_description TEXT,
      cta1_text TEXT,
      cta1_link TEXT,
      cta2_text TEXT,
      cta2_link TEXT,
      highlight_1 TEXT,
      highlight_2 TEXT,
      highlight_3 TEXT,
      highlight_4 TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS flash_sale_settings (
      id SERIAL PRIMARY KEY,
      is_enabled BOOLEAN NOT NULL DEFAULT false,
      title VARCHAR(180) NOT NULL DEFAULT 'Flash Sale hôm nay',
      description TEXT,
      starts_at TIMESTAMP,
      ends_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS banners (
      id SERIAL PRIMARY KEY,
      slot VARCHAR(40) UNIQUE NOT NULL,
      title VARCHAR(180),
      image_url TEXT,
      link_url TEXT,
      is_enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const adminEmail = 'admin@duongmart.vn';
  const sellerEmail = 'seller1@duongmart.vn';
  const buyerEmail = 'buyer1@duongmart.vn';

  const adminExists = await query('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (!adminExists.rowCount) {
    await query(
      `INSERT INTO users(name, email, password_hash, role, seller_name, referral_code, referral_rate, commission_rate)
       VALUES ($1,$2,$3,'admin',$4,$5,20,20)`,
      ['Admin DUONG MART', adminEmail, bcrypt.hashSync('admin123', 10), 'DUONG MART ADMIN', 'adminduong']
    );
  }

  const sellerExists = await query('SELECT id FROM users WHERE email = $1', [sellerEmail]);
  if (!sellerExists.rowCount) {
    await query(
      `INSERT INTO users(name, email, password_hash, role, seller_name, referral_code, referral_rate, commission_rate, wallet_balance)
       VALUES ($1,$2,$3,'seller',$4,$5,20,20,250000)`,
      ['Seller 1', sellerEmail, bcrypt.hashSync('seller123', 10), 'DUONG MART Seller 1', 'seller1']
    );
  }

  const buyerExists = await query('SELECT id FROM users WHERE email = $1', [buyerEmail]);
  if (!buyerExists.rowCount) {
    await query(
      `INSERT INTO users(name, email, password_hash, role, referral_code)
       VALUES ($1,$2,$3,'buyer',$4)`,
      ['Buyer 1', buyerEmail, bcrypt.hashSync('buyer123', 10), 'buyer1']
    );
  }

  const marketing = await query('SELECT id FROM site_marketing LIMIT 1');
  if (!marketing.rowCount) {
    await query(`INSERT INTO site_marketing(
      top_banner, hero_badge, hero_title, hero_description,
      cta1_text, cta1_link, cta2_text, cta2_link,
      highlight_1, highlight_2, highlight_3, highlight_4
    ) VALUES (
      'Miễn phí vận chuyển đơn từ 299.000đ | Flash sale mỗi ngày | Seller đối soát minh bạch',
      'BẢN FULL REDEPLOY ADMIN CMS',
      'TUYỂN CỘNG TÁC VIÊN BÁN HÀNG',
      'Admin full tính năng: chỉnh marketing, flash sale, banner quảng cáo, sản phẩm seller và buyer.',
      'Đăng ký seller', '/register?role=seller', 'Đăng nhập', '/login',
      'Admin CRUD sản phẩm full', 'Seller CRUD sản phẩm full', 'Flash sale chỉnh được', 'Banner quảng cáo editable'
    )`);
  }

  const flash = await query('SELECT id FROM flash_sale_settings LIMIT 1');
  if (!flash.rowCount) {
    await query(`INSERT INTO flash_sale_settings(is_enabled, title, description)
      VALUES (true, 'Flash Sale hôm nay', 'Giá sốc trong ngày do admin chủ động chỉnh')`);
  }

  const slots = ['hero_left', 'hero_right', 'mid_home'];
  for (const slot of slots) {
    await query(`INSERT INTO banners(slot, title, image_url, link_url, is_enabled)
      VALUES ($1,$2,$3,$4,true)
      ON CONFLICT (slot) DO NOTHING`, [slot, slot.toUpperCase(), '', '/']);
  }

  const productCount = await query('SELECT COUNT(*)::int AS c FROM products');
  if (!productCount.rows[0].c) {
    const seller = await query('SELECT id FROM users WHERE email=$1', [sellerEmail]);
    const sid = seller.rows[0].id;
    await query(`INSERT INTO products(seller_id, name, description, price, sale_price, stock, image_url, is_visible, is_featured)
      VALUES
      ($1,'Chỉ báo Smart PRO','Chỉ báo giao dịch thông minh cho forex',2999000,2499000,100,'https://i.ibb.co/FkBztNtw/HINH-CHI-BAO.jpg',true,true),
      ($1,'Hộp bảo quản thực phẩm','Sản phẩm gia dụng tiện ích',89000,69000,35,'https://images.unsplash.com/photo-1584269600519-112d071b6a0d?auto=format&fit=crop&w=900&q=80',true,true),
      ($1,'Combo rau củ sạch','Combo thực phẩm tươi',59000,49000,50,'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=900&q=80',true,true),
      ($1,'Sườn tứ quý 500g','Sườn ướp đóng gói',179000,149000,20,'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?auto=format&fit=crop&w=900&q=80',true,true)
    `, [sid]);
  }
}

async function getMarketing() {
  const rs = await query('SELECT * FROM site_marketing ORDER BY id ASC LIMIT 1');
  return rs.rows[0] || null;
}
async function getFlashSale() {
  const rs = await query('SELECT * FROM flash_sale_settings ORDER BY id ASC LIMIT 1');
  return rs.rows[0] || null;
}
async function getBanners() {
  const rs = await query('SELECT * FROM banners ORDER BY slot ASC');
  const map = {};
  rs.rows.forEach(r => map[r.slot] = r);
  return map;
}

app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.formatMoney = formatMoney;
  next();
});

function ensureAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function ensureAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
  next();
}
function ensureSeller(req, res, next) {
  if (!req.session.user || (req.session.user.role !== 'seller' && req.session.user.role !== 'admin')) return res.status(403).send('Forbidden');
  next();
}

app.get('/', async (req, res) => {
  const [marketing, flash, banners, featuredProducts] = await Promise.all([
    getMarketing(),
    getFlashSale(),
    getBanners(),
    query(`SELECT p.*, u.seller_name FROM products p LEFT JOIN users u ON u.id = p.seller_id
           WHERE p.is_visible = true ORDER BY p.is_featured DESC, p.id DESC LIMIT 12`)
  ]);
  const flashProducts = await query(`SELECT p.*, u.seller_name FROM products p LEFT JOIN users u ON u.id=p.seller_id
                                     WHERE p.is_visible = true AND p.sale_price IS NOT NULL
                                     ORDER BY p.id DESC LIMIT 8`);
  res.render('home', {
    marketing,
    flash,
    banners,
    featuredProducts: featuredProducts.rows,
    flashProducts: flashProducts.rows
  });
});

app.get('/register', async (req, res) => {
  res.render('register', { message: '', role: req.query.role || 'buyer' });
});

app.post('/register', async (req, res) => {
  const { name, email, password, role, seller_name } = req.body;
  try {
    const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rowCount) return res.render('register', { message: 'Email đã tồn tại', role });
    const refCode = (email.split('@')[0] || 'user') + Date.now().toString().slice(-4);
    await query(
      `INSERT INTO users(name, email, password_hash, role, seller_name, referral_code, referral_rate, commission_rate)
       VALUES ($1,$2,$3,$4,$5,$6,20,20)`,
      [name, email, bcrypt.hashSync(password, 10), role, role === 'seller' ? (seller_name || name) : null, refCode]
    );
    res.redirect('/login');
  } catch (e) {
    res.render('register', { message: 'Lỗi đăng ký', role });
  }
});

app.get('/login', (req, res) => res.render('login', { message: '' }));
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const rs = await query('SELECT * FROM users WHERE email=$1', [email]);
  if (!rs.rowCount) return res.render('login', { message: 'Sai tài khoản hoặc mật khẩu' });
  const user = rs.rows[0];
  if (!bcrypt.compareSync(password, user.password_hash)) return res.render('login', { message: 'Sai tài khoản hoặc mật khẩu' });
  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    seller_name: user.seller_name,
    referral_code: user.referral_code
  };
  if (user.role === 'admin') return res.redirect('/admin');
  if (user.role === 'seller') return res.redirect('/seller/products');
  return res.redirect('/');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/admin', ensureAdmin, async (req, res) => {
  const [sellerCount, buyerCount, productCount, orderCount] = await Promise.all([
    query(`SELECT COUNT(*)::int AS c FROM users WHERE role='seller'`),
    query(`SELECT COUNT(*)::int AS c FROM users WHERE role='buyer'`),
    query(`SELECT COUNT(*)::int AS c FROM products`),
    query(`SELECT COUNT(*)::int AS c FROM orders`)
  ]);
  res.render('admin-dashboard', {
    stats: {
      seller: sellerCount.rows[0].c,
      buyer: buyerCount.rows[0].c,
      products: productCount.rows[0].c,
      orders: orderCount.rows[0].c
    }
  });
});

app.get('/admin/products', ensureAdmin, async (req, res) => {
  const products = await query(`SELECT p.*, u.seller_name FROM products p LEFT JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC`);
  res.render('admin-products', { products: products.rows });
});
app.get('/admin/products/new', ensureAdmin, async (req, res) => {
  const sellers = await query(`SELECT id, seller_name, email FROM users WHERE role='seller' ORDER BY id DESC`);
  res.render('admin-product-form', { product: null, sellers: sellers.rows, action: '/admin/products', method: 'POST' });
});
app.post('/admin/products', ensureAdmin, async (req, res) => {
  const { seller_id, name, description, price, sale_price, stock, image_url, is_visible, is_featured } = req.body;
  await query(`INSERT INTO products(seller_id,name,description,price,sale_price,stock,image_url,is_visible,is_featured)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
               [seller_id || null, name, description, price || 0, sale_price || null, stock || 0, image_url, is_visible === 'on', is_featured === 'on']);
  res.redirect('/admin/products');
});
app.get('/admin/products/:id/edit', ensureAdmin, async (req, res) => {
  const product = await query(`SELECT * FROM products WHERE id=$1`, [req.params.id]);
  const sellers = await query(`SELECT id, seller_name, email FROM users WHERE role='seller' ORDER BY id DESC`);
  res.render('admin-product-form', { product: product.rows[0], sellers: sellers.rows, action: `/admin/products/${req.params.id}?_method=PUT`, method: 'POST' });
});
app.put('/admin/products/:id', ensureAdmin, async (req, res) => {
  const { seller_id, name, description, price, sale_price, stock, image_url, is_visible, is_featured } = req.body;
  await query(`UPDATE products SET seller_id=$1,name=$2,description=$3,price=$4,sale_price=$5,stock=$6,image_url=$7,is_visible=$8,is_featured=$9 WHERE id=$10`,
              [seller_id || null, name, description, price || 0, sale_price || null, stock || 0, image_url, is_visible === 'on', is_featured === 'on', req.params.id]);
  res.redirect('/admin/products');
});
app.post('/admin/products/:id/delete', ensureAdmin, async (req, res) => {
  await query('DELETE FROM products WHERE id=$1', [req.params.id]);
  res.redirect('/admin/products');
});

app.get('/admin/marketing', ensureAdmin, async (req, res) => {
  const marketing = await getMarketing();
  res.render('admin-marketing', { marketing });
});
app.post('/admin/marketing', ensureAdmin, async (req, res) => {
  const { top_banner, hero_badge, hero_title, hero_description, cta1_text, cta1_link, cta2_text, cta2_link, highlight_1, highlight_2, highlight_3, highlight_4 } = req.body;
  const current = await getMarketing();
  await query(`UPDATE site_marketing SET top_banner=$1, hero_badge=$2, hero_title=$3, hero_description=$4, cta1_text=$5, cta1_link=$6, cta2_text=$7, cta2_link=$8, highlight_1=$9, highlight_2=$10, highlight_3=$11, highlight_4=$12, updated_at=CURRENT_TIMESTAMP WHERE id=$13`,
              [top_banner, hero_badge, hero_title, hero_description, cta1_text, cta1_link, cta2_text, cta2_link, highlight_1, highlight_2, highlight_3, highlight_4, current.id]);
  res.redirect('/admin/marketing');
});

app.get('/admin/flashsale', ensureAdmin, async (req, res) => {
  const [flash, products] = await Promise.all([getFlashSale(), query('SELECT id, name, price, sale_price FROM products ORDER BY id DESC')]);
  res.render('admin-flashsale', { flash, products: products.rows });
});
app.post('/admin/flashsale', ensureAdmin, async (req, res) => {
  const { title, description, starts_at, ends_at, is_enabled } = req.body;
  const flash = await getFlashSale();
  await query(`UPDATE flash_sale_settings SET title=$1, description=$2, starts_at=$3, ends_at=$4, is_enabled=$5, updated_at=CURRENT_TIMESTAMP WHERE id=$6`,
              [title, description, starts_at || null, ends_at || null, is_enabled === 'on', flash.id]);
  res.redirect('/admin/flashsale');
});
app.post('/admin/flashsale/product/:id', ensureAdmin, async (req, res) => {
  const { sale_price } = req.body;
  await query('UPDATE products SET sale_price=$1 WHERE id=$2', [sale_price || null, req.params.id]);
  res.redirect('/admin/flashsale');
});

app.get('/admin/banners', ensureAdmin, async (req, res) => {
  const banners = await query('SELECT * FROM banners ORDER BY slot ASC');
  res.render('admin-banners', { banners: banners.rows });
});
app.post('/admin/banners/:slot', ensureAdmin, async (req, res) => {
  const { title, image_url, link_url, is_enabled } = req.body;
  await query(`UPDATE banners SET title=$1, image_url=$2, link_url=$3, is_enabled=$4, updated_at=CURRENT_TIMESTAMP WHERE slot=$5`,
              [title, image_url, link_url, is_enabled === 'on', req.params.slot]);
  res.redirect('/admin/banners');
});

app.get('/seller/products', ensureSeller, async (req, res) => {
  const userId = req.session.user.id;
  const [products, user] = await Promise.all([
    query('SELECT * FROM products WHERE seller_id=$1 ORDER BY id DESC', [userId]),
    query('SELECT * FROM users WHERE id=$1', [userId])
  ]);
  res.render('seller-products', { products: products.rows, user: user.rows[0], baseUrl: PUBLIC_BASE_URL });
});
app.get('/seller/products/new', ensureSeller, (req, res) => {
  res.render('seller-product-form', { product: null, action: '/seller/products', method: 'POST' });
});
app.post('/seller/products', ensureSeller, async (req, res) => {
  const { name, description, price, sale_price, stock, image_url, is_visible, is_featured } = req.body;
  await query(`INSERT INTO products(seller_id,name,description,price,sale_price,stock,image_url,is_visible,is_featured)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
               [req.session.user.id, name, description, price || 0, sale_price || null, stock || 0, image_url, is_visible === 'on', is_featured === 'on']);
  res.redirect('/seller/products');
});
app.get('/seller/products/:id/edit', ensureSeller, async (req, res) => {
  const product = await query('SELECT * FROM products WHERE id=$1 AND seller_id=$2', [req.params.id, req.session.user.id]);
  if (!product.rowCount) return res.status(404).send('Not found');
  res.render('seller-product-form', { product: product.rows[0], action: `/seller/products/${req.params.id}?_method=PUT`, method: 'POST' });
});
app.put('/seller/products/:id', ensureSeller, async (req, res) => {
  const { name, description, price, sale_price, stock, image_url, is_visible, is_featured } = req.body;
  await query(`UPDATE products SET name=$1,description=$2,price=$3,sale_price=$4,stock=$5,image_url=$6,is_visible=$7,is_featured=$8 WHERE id=$9 AND seller_id=$10`,
              [name, description, price || 0, sale_price || null, stock || 0, image_url, is_visible === 'on', is_featured === 'on', req.params.id, req.session.user.id]);
  res.redirect('/seller/products');
});
app.post('/seller/products/:id/delete', ensureSeller, async (req, res) => {
  await query('DELETE FROM products WHERE id=$1 AND seller_id=$2', [req.params.id, req.session.user.id]);
  res.redirect('/seller/products');
});

app.post('/cart/add/:id', async (req, res) => {
  const product = await query('SELECT * FROM products WHERE id=$1', [req.params.id]);
  if (!product.rowCount) return res.redirect('/');
  if (!req.session.cart) req.session.cart = [];
  const item = req.session.cart.find(x => x.product_id === Number(req.params.id));
  if (item) item.qty += 1;
  else req.session.cart.push({ product_id: product.rows[0].id, qty: 1 });
  res.redirect('/cart');
});
app.get('/cart', async (req, res) => {
  const cart = req.session.cart || [];
  const ids = cart.map(x => x.product_id);
  let items = [];
  if (ids.length) {
    const rs = await query(`SELECT * FROM products WHERE id = ANY($1::int[])`, [ids]);
    items = rs.rows.map(p => {
      const ci = cart.find(c => c.product_id === p.id);
      const unit = Number(p.sale_price || p.price || 0);
      return { ...p, qty: ci.qty, lineTotal: unit * ci.qty };
    });
  }
  res.render('cart', { items });
});
app.post('/checkout', ensureAuth, async (req, res) => {
  const cart = req.session.cart || [];
  if (!cart.length) return res.redirect('/cart');
  const ids = cart.map(x => x.product_id);
  const products = await query(`SELECT * FROM products WHERE id = ANY($1::int[])`, [ids]);
  const sellerId = products.rows[0]?.seller_id || null;
  let total = 0;
  products.rows.forEach(p => {
    const ci = cart.find(c => c.product_id === p.id);
    total += Number(p.sale_price || p.price || 0) * ci.qty;
  });
  const order = await query(`INSERT INTO orders(buyer_id,seller_id,total,status) VALUES($1,$2,$3,'pending') RETURNING id`, [req.session.user.id, sellerId, total]);
  for (const p of products.rows) {
    const ci = cart.find(c => c.product_id === p.id);
    await query(`INSERT INTO order_items(order_id,product_id,product_name,price,qty,image_url) VALUES($1,$2,$3,$4,$5,$6)`,
      [order.rows[0].id, p.id, p.name, Number(p.sale_price || p.price || 0), ci.qty, p.image_url]);
  }
  req.session.cart = [];
  res.redirect('/');
});

app.get('/health', (_req, res) => res.json({ ok: true }));

(async () => {
  try {
    await initDb();
    console.log('AUTO DB READY');
    app.listen(PORT, () => console.log(`DUONG MART PRO FULL REDEPLOY ADMIN CMS chạy tại cổng ${PORT}`));
  } catch (err) {
    console.error('AUTO DB ERROR', err);
    process.exit(1);
  }
})();
