require('dotenv').config();
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const { Pool } = require('pg');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const money = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';

async function addColumnIfMissing(tableName, columnName, columnDef) {
  const rs = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2",
    [tableName, columnName]
  );
  if (!rs.rowCount) {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  }
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendZalo(text) {
  const token = process.env.ZALO_OA_ACCESS_TOKEN;
  const uid = process.env.ZALO_RECIPIENT_USER_ID;
  if (!token || !uid) return;
  try {
    await postJson(
      'https://openapi.zalo.me/v3.0/oa/message/cs',
      { access_token: token },
      JSON.stringify({ recipient: { user_id: String(uid) }, message: { text } })
    );
  } catch (e) {
    console.error('Zalo error:', e.message);
  }
}

async function ensureSellerWallet(sellerId) {
  const rs = await pool.query('SELECT * FROM seller_wallets WHERE seller_id=$1', [sellerId]);
  if (rs.rowCount) return rs.rows[0];
  await pool.query(
    'INSERT INTO seller_wallets(seller_id,balance,pending_balance,total_earned,commission_rate) VALUES($1,0,0,0,10)',
    [sellerId]
  );
  return (await pool.query('SELECT * FROM seller_wallets WHERE seller_id=$1', [sellerId])).rows[0];
}

function calcOrderSummary(cart, couponCode='') {
  const subtotal = cart.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
  const discount = String(couponCode || '').trim().toUpperCase() === 'GIAM10' ? Math.round(subtotal * 0.1) : 0;
  return { subtotal, discount, total: Math.max(0, subtotal - discount) };
}

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== role && req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
    next();
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'buyer',
      phone TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cms_settings (
      id SERIAL PRIMARY KEY,
      top_banner TEXT DEFAULT 'Miễn phí ship từ 299.000đ | Flash Sale mỗi ngày | Đồ ăn sạch giao nhanh',
      hero_badge TEXT DEFAULT 'FOOD PRO MAX',
      hero_title TEXT DEFAULT 'Nền tảng bán đồ ăn đa seller',
      hero_desc TEXT DEFAULT 'CMS chỉnh web, seller đăng sản phẩm, admin duyệt, quản lý đơn và commission seller.',
      cta_primary TEXT DEFAULT 'Mua ngay',
      cta_secondary TEXT DEFAULT 'Xem Flash Sale',
      hero_image TEXT DEFAULT 'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200&auto=format&fit=crop',
      side_title TEXT DEFAULT 'Điểm nổi bật',
      side_bullets TEXT DEFAULT '🔥 Đăng bán đa seller\n⚡ Admin duyệt sản phẩm\n🚚 Đặt hàng COD\n📲 Báo đơn qua Zalo\n💰 Có hệ thống hoa hồng seller',
      free_ship_note TEXT DEFAULT 'Miễn phí ship từ 299.000đ',
      hotline TEXT DEFAULT '0900000000',
      zalo_link TEXT DEFAULT 'https://zalo.me/0900000000',
      promo_line_1 TEXT DEFAULT 'Mua nhanh – Đặt gọn – Giao liền tay',
      promo_line_2 TEXT DEFAULT 'Seller đăng sản phẩm cực nhanh',
      promo_line_3 TEXT DEFAULT 'Admin duyệt trước khi lên web',
      promo_line_4 TEXT DEFAULT 'Có commission và theo dõi doanh thu',
      section_featured_title TEXT DEFAULT 'Món bán chạy',
      section_combo_title TEXT DEFAULT 'Combo gia đình',
      section_flash_title TEXT DEFAULT 'Flash Sale hôm nay',
      shipping_city_note TEXT DEFAULT '🚀 Nội thành: giao nhanh 2–4h, shop báo phí ship sau',
      shipping_nationwide_note TEXT DEFAULT '📦 Toàn quốc: đóng gói đông lạnh, phí ship tính riêng',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      sort_order INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS banners (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      image_url TEXT NOT NULL,
      link_url TEXT DEFAULT '#',
      position TEXT DEFAULT 'home',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      category_id INT REFERENCES categories(id) ON DELETE SET NULL,
      seller_id INT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      sale_price NUMERIC(12,2),
      stock INT NOT NULL DEFAULT 0,
      image_url TEXT DEFAULT 'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?q=80&w=1000&auto=format&fit=crop',
      short_desc TEXT DEFAULT '',
      storage_note TEXT DEFAULT '',
      is_combo BOOLEAN DEFAULT false,
      is_featured BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT false,
      approval_status TEXT DEFAULT 'pending',
      rejection_note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS flash_sales (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES products(id) ON DELETE CASCADE,
      sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      start_at TIMESTAMP,
      end_at TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      note TEXT DEFAULT '',
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      shipping_method TEXT DEFAULT 'city',
      shipping_fee NUMERIC(12,2) DEFAULT 0,
      items_total NUMERIC(12,2) DEFAULT 0,
      confirmed_total NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      product_id INT REFERENCES products(id) ON DELETE SET NULL,
      seller_id INT REFERENCES users(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      quantity INT NOT NULL DEFAULT 1,
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS seller_wallets (
      id SERIAL PRIMARY KEY,
      seller_id INT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      balance NUMERIC(12,2) DEFAULT 0,
      pending_balance NUMERIC(12,2) DEFAULT 0,
      total_earned NUMERIC(12,2) DEFAULT 0,
      commission_rate NUMERIC(5,2) DEFAULT 10,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seller_commissions (
      id SERIAL PRIMARY KEY,
      seller_id INT REFERENCES users(id) ON DELETE CASCADE,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      order_item_id INT REFERENCES order_items(id) ON DELETE CASCADE,
      product_id INT REFERENCES products(id) ON DELETE SET NULL,
      base_amount NUMERIC(12,2) DEFAULT 0,
      commission_rate NUMERIC(5,2) DEFAULT 10,
      commission_amount NUMERIC(12,2) DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payout_requests (
      id SERIAL PRIMARY KEY,
      seller_id INT REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) DEFAULT 0,
      bank_info TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      admin_note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await addColumnIfMissing('cms_settings', 'promo_line_1', "TEXT DEFAULT 'Mua nhanh – Đặt gọn – Giao liền tay'");
  await addColumnIfMissing('cms_settings', 'promo_line_2', "TEXT DEFAULT 'Seller đăng sản phẩm cực nhanh'");
  await addColumnIfMissing('cms_settings', 'promo_line_3', "TEXT DEFAULT 'Admin duyệt trước khi lên web'");
  await addColumnIfMissing('cms_settings', 'promo_line_4', "TEXT DEFAULT 'Có commission và theo dõi doanh thu'");
  await addColumnIfMissing('products', 'approval_status', "TEXT DEFAULT 'pending'");
  await addColumnIfMissing('products', 'rejection_note', "TEXT DEFAULT ''");
  await addColumnIfMissing('orders', 'shipping_method', "TEXT DEFAULT 'city'");
  await addColumnIfMissing('orders', 'shipping_fee', 'NUMERIC(12,2) DEFAULT 0');
  await addColumnIfMissing('orders', 'items_total', 'NUMERIC(12,2) DEFAULT 0');
  await addColumnIfMissing('orders', 'confirmed_total', 'NUMERIC(12,2) DEFAULT 0');

  if (!(await pool.query('SELECT id FROM cms_settings LIMIT 1')).rowCount) {
    await pool.query('INSERT INTO cms_settings DEFAULT VALUES');
  }

  if (Number((await pool.query('SELECT COUNT(*)::int AS n FROM categories')).rows[0].n) === 0) {
    await pool.query(`
      INSERT INTO categories(name,slug,sort_order) VALUES
      ('Thịt ướp','thit-uop',1),
      ('Cấp đông','cap-dong',2),
      ('Combo gia đình','combo-gia-dinh',3),
      ('Ăn nhanh','an-nhanh',4),
      ('Khuyến mãi hôm nay','khuyen-mai-hom-nay',5)
    `);
  }

  if (!(await pool.query("SELECT id FROM users WHERE email='admin@duongmart.vn' LIMIT 1")).rowCount) {
    await pool.query("INSERT INTO users(name,email,password,role,phone) VALUES('Admin','admin@duongmart.vn','admin123','admin','0900000000')");
  }

  let sellerId;
  const seller = await pool.query("SELECT id FROM users WHERE email='seller1@duongmart.vn' LIMIT 1");
  if (!seller.rowCount) {
    sellerId = (await pool.query("INSERT INTO users(name,email,password,role,phone) VALUES('Food Seller','seller1@duongmart.vn','seller123','seller','0900000001') RETURNING id")).rows[0].id;
  } else {
    sellerId = seller.rows[0].id;
  }

  if (!(await pool.query("SELECT id FROM users WHERE email='buyer1@duongmart.vn' LIMIT 1")).rowCount) {
    await pool.query("INSERT INTO users(name,email,password,role,phone) VALUES('Buyer 1','buyer1@duongmart.vn','buyer123','buyer','0900000002')");
  }

  if (!(await pool.query('SELECT seller_id FROM seller_wallets WHERE seller_id=$1', [sellerId])).rowCount) {
    await pool.query('INSERT INTO seller_wallets(seller_id,balance,pending_balance,total_earned,commission_rate) VALUES($1,0,0,0,10)', [sellerId]);
  }

  if (Number((await pool.query('SELECT COUNT(*)::int AS n FROM banners')).rows[0].n) === 0) {
    await pool.query(`
      INSERT INTO banners(title,image_url,link_url,position,is_active) VALUES
      ('Combo gia đình','https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200&auto=format&fit=crop','/','home',true),
      ('Flash sale thịt ướp','https://images.unsplash.com/photo-1555939594-58d7cb561ad1?q=80&w=1200&auto=format&fit=crop','/admin/flash-sales','home',true),
      ('Đồ ăn sạch giao nhanh','https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?q=80&w=1200&auto=format&fit=crop','/','home',true)
    `);
  }

  if (Number((await pool.query('SELECT COUNT(*)::int AS n FROM products')).rows[0].n) === 0) {
    const rows = await pool.query('SELECT id, slug FROM categories');
    const m = {};
    rows.rows.forEach(r => m[r.slug] = r.id);
    await pool.query(
      `INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active,approval_status)
       VALUES
       ($1,$4,'SƯỜN TỨ QUÝ 500g',195000,185000,25,'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?q=80&w=1000&auto=format&fit=crop','Sườn ướp sẵn đậm vị','Bảo quản ngăn đông',false,true,true,'approved'),
       ($2,$4,'Combo gia đình 1kg',299000,259000,20,'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1000&auto=format&fit=crop','Combo tiện lợi cho 3-4 người','Giữ lạnh 0-4°C',true,true,true,'approved'),
       ($3,$4,'Ba chỉ cuộn cấp đông',129000,109000,40,'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?q=80&w=1000&auto=format&fit=crop','Đóng gói sạch, dễ chế biến','Bảo quản ngăn đông',false,false,true,'approved')`,
      [m['thit-uop'], m['combo-gia-dinh'], m['cap-dong'], sellerId]
    );
  }
}

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(methodOverride('_method'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'duongmartpro',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.cart = req.session.cart || [];
  try {
    res.locals.cms = (await pool.query('SELECT * FROM cms_settings LIMIT 1')).rows[0] || null;
  } catch {
    res.locals.cms = null;
  }
  next();
});

app.get('/', async (req, res) => {
  const categories = (await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC')).rows;
  const banners = (await pool.query("SELECT * FROM banners WHERE is_active=true AND position='home' ORDER BY id ASC")).rows;
  const featured = (await pool.query("SELECT * FROM products WHERE is_featured=true AND is_active=true AND approval_status='approved' ORDER BY id DESC LIMIT 8")).rows;
  const combos = (await pool.query("SELECT * FROM products WHERE is_combo=true AND is_active=true AND approval_status='approved' ORDER BY id DESC LIMIT 6")).rows;
  const flashSales = (await pool.query("SELECT fs.*, p.name, p.image_url, p.price AS original_price, p.id AS product_id FROM flash_sales fs JOIN products p ON p.id=fs.product_id WHERE fs.is_active=true AND p.is_active=true AND p.approval_status='approved' ORDER BY fs.id DESC")).rows;
  res.render('home', { categories, banners, featured, combos, flashSales, money });
});

app.get('/category/:slug', async (req, res) => {
  const category = await pool.query('SELECT * FROM categories WHERE slug=$1 LIMIT 1', [req.params.slug]);
  if (!category.rowCount) return res.status(404).send('Không tìm thấy danh mục');
  const products = (await pool.query("SELECT * FROM products WHERE category_id=$1 AND is_active=true AND approval_status='approved' ORDER BY id DESC", [category.rows[0].id])).rows;
  res.render('category', { category: category.rows[0], products, money });
});

app.get('/register', (req, res) => res.render('register', { error:'' }));
app.post('/register', async (req, res) => {
  try {
    const role = req.body.role === 'seller' ? 'seller' : 'buyer';
    const rs = await pool.query('INSERT INTO users(name,email,password,role,phone) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.body.name, req.body.email, req.body.password, role, req.body.phone || '']);
    if (role === 'seller') await pool.query('INSERT INTO seller_wallets(seller_id,balance,pending_balance,total_earned,commission_rate) VALUES($1,0,0,0,10)', [rs.rows[0].id]);
    res.redirect('/login');
  } catch {
    res.render('register', { error:'Email đã tồn tại hoặc dữ liệu chưa hợp lệ.' });
  }
});

app.get('/login', (req, res) => res.render('login', { error:'' }));
app.post('/login', async (req, res) => {
  const rs = await pool.query('SELECT id,name,email,role,phone FROM users WHERE email=$1 AND password=$2 LIMIT 1', [req.body.email, req.body.password]);
  if (!rs.rowCount) return res.render('login', { error:'Sai email hoặc mật khẩu.' });
  req.session.user = rs.rows[0];
  if (rs.rows[0].role === 'admin') return res.redirect('/admin');
  if (rs.rows[0].role === 'seller') return res.redirect('/seller/products');
  res.redirect('/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.post('/cart/add/:id', async (req, res) => {
  const p = await pool.query("SELECT * FROM products WHERE id=$1 AND is_active=true AND approval_status='approved' LIMIT 1", [req.params.id]);
  if (!p.rowCount) return res.redirect('/');
  const product = p.rows[0];
  const cart = getCart(req);
  const found = cart.find(i => i.product_id === Number(product.id));
  const price = Number(product.sale_price || product.price || 0);
  if (found) found.quantity += 1;
  else cart.push({ product_id:Number(product.id), seller_id:product.seller_id, name:product.name, price, image_url:product.image_url, quantity:1 });
  res.redirect('/cart');
});
app.post('/cart/increase/:id', (req, res) => { const item = getCart(req).find(i => i.product_id === Number(req.params.id)); if (item) item.quantity += 1; res.redirect('/cart'); });
app.post('/cart/decrease/:id', (req, res) => { const id = Number(req.params.id); const cart = getCart(req); const item = cart.find(i => i.product_id === id); if (item) { item.quantity -= 1; if (item.quantity <= 0) req.session.cart = cart.filter(i => i.product_id !== id); } res.redirect('/cart'); });
app.post('/cart/remove/:id', (req, res) => { req.session.cart = getCart(req).filter(i => i.product_id !== Number(req.params.id)); res.redirect('/cart'); });
app.get('/cart', (req, res) => res.render('cart', { cart:getCart(req), summary:calcOrderSummary(getCart(req)), money }));

app.get('/checkout', (req, res) => {
  const cart = getCart(req);
  if (!cart.length) return res.redirect('/cart');
  res.render('checkout', { cart, summary:calcOrderSummary(cart), error:'', form:{}, money });
});

app.post('/checkout', async (req, res) => {
  const cart = getCart(req);
  const summary = calcOrderSummary(cart, req.body.coupon_code);
  if (!cart.length) return res.redirect('/cart');
  if (!req.body.customer_name || !req.body.phone || !req.body.address) {
    return res.render('checkout', { cart, summary, error:'Vui lòng nhập đủ họ tên, số điện thoại, địa chỉ.', form:req.body, money });
  }
  const method = req.body.shipping_method === 'nationwide' ? 'nationwide' : 'city';
  const order = (await pool.query(
    'INSERT INTO orders(user_id,customer_name,phone,address,note,total,status,shipping_method,shipping_fee,items_total,confirmed_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,0) RETURNING *',
    [req.session.user?.id || null, req.body.customer_name, req.body.phone, req.body.address, req.body.note || '', summary.total, 'new', method, summary.total]
  )).rows[0];

  for (const item of cart) {
    const subtotal = Number(item.price) * Number(item.quantity);
    const orderItem = (await pool.query(
      'INSERT INTO order_items(order_id,product_id,seller_id,product_name,price,quantity,subtotal) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [order.id, item.product_id, item.seller_id || null, item.name, item.price, item.quantity, subtotal]
    )).rows[0];
    await pool.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [item.quantity, item.product_id]);

    if (item.seller_id) {
      const wallet = await ensureSellerWallet(item.seller_id);
      const rate = Number(wallet.commission_rate || 10);
      const commissionAmount = subtotal * rate / 100;
      await pool.query(
        'INSERT INTO seller_commissions(seller_id,order_id,order_item_id,product_id,base_amount,commission_rate,commission_amount,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [item.seller_id, order.id, orderItem.id, item.product_id, subtotal, rate, commissionAmount, 'pending']
      );
      await pool.query(
        'UPDATE seller_wallets SET pending_balance = pending_balance + $1, total_earned = total_earned + $1, updated_at = CURRENT_TIMESTAMP WHERE seller_id=$2',
        [commissionAmount, item.seller_id]
      );
    }
  }

  await sendZalo(['ĐƠN HÀNG MỚI', `Mã đơn: #${order.id}`, `Khách: ${order.customer_name}`, `SĐT: ${order.phone}`, `Tiền hàng tạm tính: ${money(order.items_total)}`].join('\n'));
  req.session.cart = [];
  res.render('order-pending', { orderId:order.id, shippingMethod:method, itemsTotal:summary.total, money });
});

app.get('/my-orders', requireLogin, async (req, res) => {
  const orders = (await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC', [req.session.user.id])).rows;
  res.render('my-orders', { orders, money });
});

app.get('/admin', requireRole('admin'), async (req, res) => {
  const productCount = (await pool.query('SELECT COUNT(*)::int AS n FROM products')).rows[0].n;
  const orderCount = (await pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
  const pendingCount = (await pool.query("SELECT COUNT(*)::int AS n FROM products WHERE approval_status='pending'")).rows[0].n;
  const revenue = (await pool.query('SELECT COALESCE(SUM(CASE WHEN confirmed_total > 0 THEN confirmed_total ELSE total END),0)::numeric AS t FROM orders')).rows[0].t;
  const commissionPool = (await pool.query('SELECT COALESCE(SUM(balance + pending_balance),0)::numeric AS t FROM seller_wallets')).rows[0].t;
  res.render('admin-dashboard', { productCount, orderCount, pendingCount, revenue, commissionPool, money });
});

app.get('/admin/products', requireRole('admin'), async (req, res) => {
  const products = (await pool.query('SELECT p.*, u.name AS seller_name FROM products p LEFT JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC')).rows;
  const categories = (await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC')).rows;
  const sellers = (await pool.query("SELECT id,name FROM users WHERE role='seller' ORDER BY id ASC")).rows;
  res.render('admin-products', { products, categories, sellers, money });
});
app.post('/admin/products', requireRole('admin'), async (req, res) => {
  const b = req.body;
  await pool.query(
    "INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active,approval_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved')",
    [b.category_id || null, b.seller_id || null, b.name, b.price || 0, b.sale_price || null, b.stock || 0, b.image_url, b.short_desc, b.storage_note, b.is_combo === 'on', b.is_featured === 'on', b.is_active === 'on']
  );
  res.redirect('/admin/products');
});

app.get('/admin/seller-approvals', requireRole('admin'), async (req, res) => {
  const products = (await pool.query("SELECT p.*, u.name AS seller_name FROM products p LEFT JOIN users u ON u.id=p.seller_id WHERE p.seller_id IS NOT NULL ORDER BY CASE p.approval_status WHEN 'pending' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END, p.id DESC")).rows;
  res.render('admin-seller-approvals', { products, money });
});
app.post('/admin/seller-approvals/:id/approve', requireRole('admin'), async (req, res) => { await pool.query("UPDATE products SET approval_status='approved', is_active=true, rejection_note='' WHERE id=$1", [req.params.id]); res.redirect('/admin/seller-approvals'); });
app.post('/admin/seller-approvals/:id/reject', requireRole('admin'), async (req, res) => { await pool.query("UPDATE products SET approval_status='rejected', is_active=false, rejection_note=$1 WHERE id=$2", [req.body.rejection_note || '', req.params.id]); res.redirect('/admin/seller-approvals'); });
app.post('/admin/seller-approvals/:id/hide', requireRole('admin'), async (req, res) => { await pool.query("UPDATE products SET approval_status='hidden', is_active=false WHERE id=$1", [req.params.id]); res.redirect('/admin/seller-approvals'); });

app.get('/seller/products', requireRole('seller'), async (req, res) => {
  const products = (await pool.query('SELECT * FROM products WHERE seller_id=$1 ORDER BY id DESC', [req.session.user.id])).rows;
  const categories = (await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC')).rows;
  res.render('seller-products', { products, categories, money });
});
app.post('/seller/products', requireRole('seller'), async (req, res) => {
  const b = req.body;
  await pool.query(
    "INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active,approval_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,'pending')",
    [b.category_id || null, req.session.user.id, b.name, b.price || 0, b.sale_price || null, b.stock || 0, b.image_url, b.short_desc, b.storage_note, b.is_combo === 'on', b.is_featured === 'on']
  );
  res.redirect('/seller/products');
});

app.get('/seller/wallet', requireRole('seller'), async (req, res) => {
  const wallet = await ensureSellerWallet(req.session.user.id);
  const commissions = (await pool.query('SELECT * FROM seller_commissions WHERE seller_id=$1 ORDER BY id DESC', [req.session.user.id])).rows;
  const payouts = (await pool.query('SELECT * FROM payout_requests WHERE seller_id=$1 ORDER BY id DESC', [req.session.user.id])).rows;
  res.render('seller-wallet', { wallet, commissions, payouts, money });
});
app.post('/seller/wallet/request-payout', requireRole('seller'), async (req, res) => {
  const amt = Number(req.body.amount || 0);
  const wallet = await ensureSellerWallet(req.session.user.id);
  if (amt <= 0 || amt > Number(wallet.balance || 0)) return res.redirect('/seller/wallet');
  await pool.query('INSERT INTO payout_requests(seller_id,amount,bank_info,status) VALUES($1,$2,$3,$4)', [req.session.user.id, amt, req.body.bank_info || '', 'pending']);
  await pool.query('UPDATE seller_wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE seller_id=$2', [amt, req.session.user.id]);
  res.redirect('/seller/wallet');
});

app.get('/admin/commissions', requireRole('admin'), async (req, res) => {
  const wallets = (await pool.query('SELECT sw.*, u.name, u.email FROM seller_wallets sw JOIN users u ON u.id=sw.seller_id ORDER BY sw.total_earned DESC')).rows;
  const payouts = (await pool.query('SELECT p.*, u.name FROM payout_requests p JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC')).rows;
  res.render('admin-commissions', { wallets, payouts, money });
});
app.post('/admin/commissions/:sellerId/release-pending', requireRole('admin'), async (req, res) => {
  const sellerId = Number(req.params.sellerId);
  const total = Number((await pool.query("SELECT COALESCE(SUM(commission_amount),0)::numeric AS t FROM seller_commissions WHERE seller_id=$1 AND status='pending'", [sellerId])).rows[0].t);
  await pool.query("UPDATE seller_commissions SET status='released' WHERE seller_id=$1 AND status='pending'", [sellerId]);
  await pool.query('UPDATE seller_wallets SET pending_balance = GREATEST(0, pending_balance - $1), balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE seller_id=$2', [total, sellerId]);
  res.redirect('/admin/commissions');
});
app.post('/admin/payouts/:id/:action', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const action = req.params.action;
  const rs = await pool.query('SELECT * FROM payout_requests WHERE id=$1 LIMIT 1', [id]);
  if (!rs.rowCount) return res.redirect('/admin/commissions');
  const p = rs.rows[0];
  if (action === 'approve') {
    await pool.query("UPDATE payout_requests SET status='approved', admin_note=$1 WHERE id=$2", [req.body.admin_note || '', id]);
  } else if (action === 'reject') {
    await pool.query("UPDATE payout_requests SET status='rejected', admin_note=$1 WHERE id=$2", [req.body.admin_note || '', id]);
    await pool.query('UPDATE seller_wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE seller_id=$2', [p.amount, p.seller_id]);
  }
  res.redirect('/admin/commissions');
});

app.get('/admin/orders', requireRole('admin'), async (req, res) => {
  const orders = (await pool.query('SELECT * FROM orders ORDER BY id DESC')).rows;
  res.render('admin-orders', { orders, money });
});
app.post('/admin/orders/:id/update', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const ship = Number(req.body.shipping_fee || 0);
  const status = req.body.status;
  const orderRs = await pool.query('SELECT * FROM orders WHERE id=$1 LIMIT 1', [id]);
  if (!orderRs.rowCount) return res.redirect('/admin/orders');
  const order = orderRs.rows[0];
  const confirmedTotal = Number(order.items_total || order.total || 0) + ship;
  await pool.query('UPDATE orders SET status=$1, shipping_fee=$2, confirmed_total=$3, total=$4 WHERE id=$5', [status || order.status, ship, confirmedTotal, confirmedTotal, id]);
  if (status === 'confirmed') {
    await sendZalo(['ĐƠN HÀNG ĐÃ XÁC NHẬN ✅', `Mã đơn: #${order.id}`, `Khách: ${order.customer_name}`, `Tổng thanh toán: ${money(confirmedTotal)}`].join('\n'));
  }
  res.redirect('/admin/orders');
});

app.get('/admin/cms', requireRole('admin'), async (req, res) => {
  const cms = (await pool.query('SELECT * FROM cms_settings LIMIT 1')).rows[0];
  const banners = (await pool.query('SELECT * FROM banners ORDER BY id DESC')).rows;
  res.render('admin-cms', { cms, banners });
});
app.post('/admin/cms', requireRole('admin'), async (req, res) => {
  const b = req.body;
  await pool.query(
    `UPDATE cms_settings SET
      top_banner=$1, hero_badge=$2, hero_title=$3, hero_desc=$4, cta_primary=$5, cta_secondary=$6, hero_image=$7,
      side_title=$8, side_bullets=$9, free_ship_note=$10, hotline=$11, zalo_link=$12,
      promo_line_1=$13, promo_line_2=$14, promo_line_3=$15, promo_line_4=$16,
      section_featured_title=$17, section_combo_title=$18, section_flash_title=$19,
      shipping_city_note=$20, shipping_nationwide_note=$21, updated_at=CURRENT_TIMESTAMP
      WHERE id=(SELECT id FROM cms_settings LIMIT 1)`,
    [b.top_banner,b.hero_badge,b.hero_title,b.hero_desc,b.cta_primary,b.cta_secondary,b.hero_image,b.side_title,b.side_bullets,b.free_ship_note,b.hotline,b.zalo_link,b.promo_line_1,b.promo_line_2,b.promo_line_3,b.promo_line_4,b.section_featured_title,b.section_combo_title,b.section_flash_title,b.shipping_city_note,b.shipping_nationwide_note]
  );
  res.redirect('/admin/cms');
});
app.post('/admin/banners', requireRole('admin'), async (req, res) => {
  await pool.query('INSERT INTO banners(title,image_url,link_url,position,is_active) VALUES($1,$2,$3,$4,$5)', [req.body.title, req.body.image_url, req.body.link_url, req.body.position || 'home', req.body.is_active === 'on']);
  res.redirect('/admin/cms');
});

app.get('/admin/flash-sales', requireRole('admin'), async (req, res) => {
  const flashSales = (await pool.query("SELECT fs.*, p.name FROM flash_sales fs LEFT JOIN products p ON p.id=fs.product_id WHERE p.approval_status='approved' ORDER BY fs.id DESC")).rows;
  const products = (await pool.query("SELECT id,name FROM products WHERE is_active=true AND approval_status='approved' ORDER BY id DESC")).rows;
  res.render('admin-flash-sales', { flashSales, products, money });
});
app.post('/admin/flash-sales', requireRole('admin'), async (req, res) => {
  await pool.query('INSERT INTO flash_sales(product_id,sale_price,start_at,end_at,is_active) VALUES($1,$2,$3,$4,$5)', [req.body.product_id, req.body.sale_price || 0, req.body.start_at || null, req.body.end_at || null, req.body.is_active === 'on']);
  res.redirect('/admin/flash-sales');
});

app.get('/health', (req, res) => res.send('OK'));

(async () => {
  try {
    await initDb();
    console.log('DB READY');
    app.listen(PORT, () => console.log('Server running on ' + PORT));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
