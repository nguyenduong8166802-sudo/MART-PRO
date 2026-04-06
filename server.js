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

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendZaloOrderNotification(order, mode='new') {
  const accessToken = process.env.ZALO_OA_ACCESS_TOKEN;
  const recipientUserId = process.env.ZALO_RECIPIENT_USER_ID;
  if (!accessToken || !recipientUserId) return { ok: false, skipped: true };

  let text = '';
  if (mode === 'confirmed') {
    text = [
      'ĐƠN HÀNG ĐÃ XÁC NHẬN ✅',
      `Mã đơn: #${order.id}`,
      `Khách: ${order.customer_name}`,
      `Loại ship: ${order.shipping_method === 'city' ? 'Nội thành' : 'Toàn quốc'}`,
      `Tiền hàng: ${Number(order.items_total || 0).toLocaleString('vi-VN')}đ`,
      `Phí ship: ${Number(order.shipping_fee || 0).toLocaleString('vi-VN')}đ`,
      `Tổng thanh toán: ${Number(order.total).toLocaleString('vi-VN')}đ`,
      order.note ? `Ghi chú: ${order.note}` : ''
    ].filter(Boolean).join('\n');
  } else {
    text = [
      'ĐƠN HÀNG MỚI',
      `Mã đơn: #${order.id}`,
      `Khách: ${order.customer_name}`,
      `SĐT: ${order.phone}`,
      `Loại ship: ${order.shipping_method === 'city' ? 'Nội thành' : 'Toàn quốc'}`,
      `Tiền hàng tạm tính: ${Number(order.items_total || order.total || 0).toLocaleString('vi-VN')}đ`,
      'Phí ship: shop sẽ xác nhận sau',
      order.note ? `Ghi chú: ${order.note}` : ''
    ].filter(Boolean).join('\n');
  }

  return await postJson(
    'https://openapi.zalo.me/v3.0/oa/message/cs',
    { access_token: accessToken },
    JSON.stringify({
      recipient: { user_id: String(recipientUserId) },
      message: { text }
    })
  );
}

async function addColumnIfMissing(tableName, columnName, columnDef) {
  const rs = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
    [tableName, columnName]
  );
  if (!rs.rowCount) {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  }
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
      hero_badge TEXT DEFAULT 'FOOD PRO SALES',
      hero_title TEXT DEFAULT 'Shopee mini bán đồ ăn - tối ưu chốt đơn',
      hero_desc TEXT DEFAULT 'Bán hàng thật, giỏ hàng, checkout COD, quản lý đơn, admin CMS, flash sale, banner và tối ưu bán hàng.',
      cta_primary TEXT DEFAULT 'Mua ngay',
      cta_secondary TEXT DEFAULT 'Xem Flash Sale',
      hero_image TEXT DEFAULT 'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200&auto=format&fit=crop',
      side_title TEXT DEFAULT 'Điểm nổi bật',
      side_bullets TEXT DEFAULT '🔥 Combo tiết kiệm đến 30%\n⚡ Flash Sale mỗi ngày\n🚚 Giao hàng toàn quốc\n📲 Nhận đơn qua Zalo realtime\n📦 Quản lý tồn kho tự động',
      free_ship_note TEXT DEFAULT 'Miễn phí ship từ 299.000đ',
      hotline TEXT DEFAULT '0900000000',
      zalo_link TEXT DEFAULT 'https://zalo.me/0900000000',
      promo_line_1 TEXT DEFAULT 'Mua nhanh – Đặt gọn – Giao liền tay',
      promo_line_2 TEXT DEFAULT 'Đặt hàng chỉ 10 giây',
      promo_line_3 TEXT DEFAULT 'Giao diện đơn giản – ai cũng dùng được',
      promo_line_4 TEXT DEFAULT 'Không cần app – mở web là mua',
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
      is_active BOOLEAN DEFAULT true,
      approval_status TEXT DEFAULT 'approved',
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
      product_name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      quantity INT NOT NULL DEFAULT 1,
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0
    );
  `);

  await addColumnIfMissing('products', 'approval_status', "TEXT DEFAULT 'approved'");
  await addColumnIfMissing('products', 'rejection_note', "TEXT DEFAULT ''");
  await addColumnIfMissing('orders', 'shipping_method', "TEXT DEFAULT 'city'");
  await addColumnIfMissing('orders', 'shipping_fee', 'NUMERIC(12,2) DEFAULT 0');
  await addColumnIfMissing('orders', 'items_total', 'NUMERIC(12,2) DEFAULT 0');
  await addColumnIfMissing('orders', 'confirmed_total', 'NUMERIC(12,2) DEFAULT 0');

  const cms = await pool.query('SELECT id FROM cms_settings LIMIT 1');
  if (!cms.rowCount) await pool.query('INSERT INTO cms_settings DEFAULT VALUES');

  const cats = await pool.query('SELECT COUNT(*)::int AS n FROM categories');
  if (cats.rows[0].n === 0) {
    await pool.query(`
      INSERT INTO categories(name,slug,sort_order) VALUES
      ('Thịt ướp','thit-uop',1),
      ('Cấp đông','cap-dong',2),
      ('Combo gia đình','combo-gia-dinh',3),
      ('Ăn nhanh','an-nhanh',4),
      ('Khuyến mãi hôm nay','khuyen-mai-hom-nay',5)
    `);
  }

  const admin = await pool.query("SELECT id FROM users WHERE email='admin@duongmart.vn' LIMIT 1");
  if (!admin.rowCount) {
    await pool.query("INSERT INTO users(name,email,password,role,phone) VALUES($1,$2,$3,$4,$5)", ['Admin','admin@duongmart.vn','admin123','admin','0900000000']);
  }

  const seller = await pool.query("SELECT id FROM users WHERE email='seller1@duongmart.vn' LIMIT 1");
  let sellerId;
  if (!seller.rowCount) {
    const rs = await pool.query("INSERT INTO users(name,email,password,role,phone) VALUES($1,$2,$3,$4,$5) RETURNING id", ['Food Seller','seller1@duongmart.vn','seller123','seller','0900000001']);
    sellerId = rs.rows[0].id;
  } else {
    sellerId = seller.rows[0].id;
  }

  const buyer = await pool.query("SELECT id FROM users WHERE email='buyer1@duongmart.vn' LIMIT 1");
  if (!buyer.rowCount) {
    await pool.query("INSERT INTO users(name,email,password,role,phone) VALUES($1,$2,$3,$4,$5)", ['Buyer 1','buyer1@duongmart.vn','buyer123','buyer','0900000002']);
  }

  const banners = await pool.query('SELECT COUNT(*)::int AS n FROM banners');
  if (banners.rows[0].n === 0) {
    await pool.query(`
      INSERT INTO banners(title,image_url,link_url,position,is_active) VALUES
      ('Combo gia đình','https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1200&auto=format&fit=crop','/','home',true),
      ('Flash sale thịt ướp','https://images.unsplash.com/photo-1555939594-58d7cb561ad1?q=80&w=1200&auto=format&fit=crop','/admin/flash-sales','home',true),
      ('Đồ ăn sạch giao nhanh','https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?q=80&w=1200&auto=format&fit=crop','/','home',true)
    `);
  }

  const prods = await pool.query('SELECT COUNT(*)::int AS n FROM products');
  if (prods.rows[0].n === 0) {
    const rows = await pool.query('SELECT id, slug FROM categories');
    const m = {}; rows.rows.forEach(r => m[r.slug] = r.id);
    await pool.query(`
      INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active,approval_status) VALUES
      ($1,$6,'SƯỜN TỨ QUÝ 500g',195000,195000,25,'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?q=80&w=1000&auto=format&fit=crop','Sườn ướp sẵn đậm vị','Bảo quản ngăn đông',false,true,true),
      ($2,$6,'Combo gia đình 1kg',299000,259000,20,'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1000&auto=format&fit=crop','Combo tiện lợi cho 3-4 người','Giữ lạnh 0-4°C',true,true,true),
      ($3,$6,'Ba chỉ cuộn cấp đông',129000,109000,40,'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?q=80&w=1000&auto=format&fit=crop','Đóng gói sạch, dễ chế biến','Bảo quản ngăn đông',false,false,true),
      ($4,$6,'Cơm cháy chà bông',59000,NULL,60,'https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=1000&auto=format&fit=crop','Ăn nhanh, tiện lợi','Nơi khô ráo',false,false,true),
      ($5,$6,'Gà ướp mật ong',189000,159000,18,'https://images.unsplash.com/photo-1527477396000-e27163b481c2?q=80&w=1000&auto=format&fit=crop','Món hot khuyến mãi hôm nay','Bảo quản ngăn mát',false,true,true,'approved')
    `, [m['thit-uop'],m['combo-gia-dinh'],m['cap-dong'],m['an-nhanh'],m['khuyen-mai-hom-nay'],sellerId]);
  }

  const fs = await pool.query('SELECT COUNT(*)::int AS n FROM flash_sales');
  if (fs.rows[0].n === 0) {
    const rows = await pool.query('SELECT id, price FROM products ORDER BY id ASC LIMIT 2');
    const now = new Date();
    const end = new Date(now.getTime() + 24*60*60*1000);
    for (const row of rows.rows) {
      await pool.query('INSERT INTO flash_sales(product_id,sale_price,start_at,end_at,is_active) VALUES($1,$2,$3,$4,true)', [row.id, Number(row.price)*0.85, now, end]);
    }
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

app.use(async (req,res,next)=>{
  res.locals.currentUser = req.session.user || null;
  res.locals.cart = req.session.cart || [];
  try {
    const cms = await pool.query('SELECT * FROM cms_settings LIMIT 1');
    res.locals.cms = cms.rows[0] || null;
  } catch {
    res.locals.cms = null;
  }
  next();
});

function requireLogin(req,res,next){ if(!req.session.user) return res.redirect('/login'); next(); }
function requireRole(role){ return (req,res,next)=>{ if(!req.session.user) return res.redirect('/login'); if(req.session.user.role !== role && req.session.user.role !== 'admin') return res.status(403).send('Forbidden'); next(); }; }
function getCart(req){ if(!req.session.cart) req.session.cart = []; return req.session.cart; }
function calcOrderSummary(cart, couponCode='') {
  const subtotal = cart.reduce((s,i)=>s + Number(i.price) * Number(i.quantity), 0);
  let discount = 0;
  const code = String(couponCode || '').trim().toUpperCase();
  if (code === 'GIAM10') discount = Math.round(subtotal * 0.10);
  return { subtotal, discount, total: Math.max(0, subtotal - discount), code };
}
async function checkSpamOrder(phone){
  const rs = await pool.query('SELECT created_at FROM orders WHERE phone=$1 ORDER BY id DESC LIMIT 1', [phone]);
  if (!rs.rowCount) return false;
  return (new Date() - new Date(rs.rows[0].created_at)) < 60000;
}

app.get('/', async (req,res)=>{
  const categories = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
  const banners = await pool.query("SELECT * FROM banners WHERE is_active=true AND position='home' ORDER BY id ASC");
  const featured = await pool.query('SELECT * FROM products WHERE is_featured=true AND is_active=true AND approval_status='approved' ORDER BY id DESC LIMIT 8');
  const combos = await pool.query('SELECT * FROM products WHERE is_combo=true AND is_active=true AND approval_status='approved' ORDER BY id DESC LIMIT 6');
  const flashSales = await pool.query(`
    SELECT fs.*, p.name, p.image_url, p.price AS original_price, p.id AS product_id
    FROM flash_sales fs JOIN products p ON p.id=fs.product_id
    WHERE fs.is_active=true AND p.is_active=true AND p.approval_status='approved'
      AND (fs.start_at IS NULL OR fs.start_at <= CURRENT_TIMESTAMP)
      AND (fs.end_at IS NULL OR fs.end_at >= CURRENT_TIMESTAMP)
    ORDER BY fs.id DESC
  `);
  res.render('home',{ categories: categories.rows, banners: banners.rows, featured: featured.rows, combos: combos.rows, flashSales: flashSales.rows });
});

app.get('/category/:slug', async (req,res)=>{
  const category = await pool.query('SELECT * FROM categories WHERE slug=$1 LIMIT 1', [req.params.slug]);
  if (!category.rowCount) return res.status(404).send('Không tìm thấy danh mục');
  const products = await pool.query('SELECT * FROM products WHERE category_id=$1 AND is_active=true AND approval_status='approved' ORDER BY id DESC', [category.rows[0].id]);
  res.render('category',{ category: category.rows[0], products: products.rows });
});

app.get('/register',(req,res)=>res.render('register',{error:''}));
app.post('/register', async (req,res)=>{
  const { name,email,password,role,phone } = req.body;
  try{
    await pool.query('INSERT INTO users(name,email,password,role,phone) VALUES($1,$2,$3,$4,$5)', [name,email,password,role==='seller'?'seller':'buyer',phone||'']);
    res.redirect('/login');
  }catch{
    res.render('register',{error:'Email đã tồn tại hoặc dữ liệu chưa hợp lệ.'});
  }
});

app.get('/login',(req,res)=>res.render('login',{error:''}));
app.post('/login', async (req,res)=>{
  const { email,password } = req.body;
  const rs = await pool.query('SELECT id,name,email,role,phone FROM users WHERE email=$1 AND password=$2 LIMIT 1', [email,password]);
  if(!rs.rowCount) return res.render('login',{error:'Sai email hoặc mật khẩu.'});
  req.session.user = rs.rows[0];
  if (rs.rows[0].role === 'admin') return res.redirect('/admin');
  if (rs.rows[0].role === 'seller') return res.redirect('/seller/products');
  res.redirect('/');
});
app.post('/logout',(req,res)=>req.session.destroy(()=>res.redirect('/')));

app.post('/cart/add/:id', async (req,res)=>{
  const p = await pool.query('SELECT * FROM products WHERE id=$1 AND is_active=true AND approval_status='approved' LIMIT 1',[req.params.id]);
  if(!p.rowCount) return res.redirect('/');
  const product = p.rows[0];
  if(Number(product.stock) <= 0) return res.send('Sản phẩm đã hết hàng');
  const cart = getCart(req);
  const found = cart.find(i => i.product_id === Number(product.id));
  const price = Number(product.sale_price || product.price || 0);
  if(found){ if(found.quantity < Number(product.stock)) found.quantity += 1; }
  else { cart.push({ product_id: Number(product.id), name: product.name, price, image_url: product.image_url, quantity: 1 }); }
  req.session.cart = cart;
  res.redirect('/cart');
});

app.post('/cart/increase/:id', async (req,res)=>{
  const productId = Number(req.params.id);
  const productRs = await pool.query('SELECT id, stock, is_active FROM products WHERE id=$1 LIMIT 1', [productId]);
  if (!productRs.rowCount) return res.redirect('/cart');
  const product = productRs.rows[0];
  const cart = getCart(req);
  const item = cart.find(i => i.product_id === productId);
  if (item && product.is_active && item.quantity < Number(product.stock)) item.quantity += 1;
  req.session.cart = cart;
  res.redirect('/cart');
});

app.post('/cart/decrease/:id', (req,res)=>{
  const productId = Number(req.params.id);
  const cart = getCart(req);
  const item = cart.find(i => i.product_id === productId);
  if (item) {
    item.quantity -= 1;
    if (item.quantity <= 0) req.session.cart = cart.filter(i => i.product_id !== productId);
    else req.session.cart = cart;
  }
  res.redirect('/cart');
});

app.get('/cart',(req,res)=>{
  const cart = getCart(req);
  const summary = calcOrderSummary(cart);
  res.render('cart',{ cart, total: summary.total, subtotal: summary.subtotal, freeShipThreshold: 299000 });
});

app.post('/cart/remove/:id',(req,res)=>{
  req.session.cart = getCart(req).filter(i => i.product_id !== Number(req.params.id));
  res.redirect('/cart');
});

app.get('/checkout',(req,res)=>{
  const cart = getCart(req);
  if(!cart.length) return res.redirect('/cart');
  const summary = calcOrderSummary(cart);
  res.render('checkout',{ cart, summary, error:'', form:{} });
});

app.post('/checkout', async (req,res)=>{
  const cart = getCart(req);
  const { customer_name, phone, address, note, coupon_code, shipping_method } = req.body;
  const method = shipping_method === 'nationwide' ? 'nationwide' : 'city';
  const summary = calcOrderSummary(cart, coupon_code);
  if(!cart.length) return res.redirect('/cart');
  if(!customer_name || !phone || !address) return res.render('checkout',{cart,summary,error:'Vui lòng nhập đủ họ tên, số điện thoại, địa chỉ.',form:req.body});
  if(await checkSpamOrder(phone)) return res.render('checkout',{cart,summary,error:'Bạn đặt hàng quá nhanh. Vui lòng thử lại sau 1 phút.',form:req.body});

  for (const item of cart) {
    const p = await pool.query('SELECT stock FROM products WHERE id=$1 LIMIT 1',[item.product_id]);
    if(!p.rowCount || Number(p.rows[0].stock) < Number(item.quantity)) {
      return res.render('checkout',{cart,summary,error:'Có sản phẩm không đủ tồn kho. Vui lòng kiểm tra lại giỏ hàng.',form:req.body});
    }
  }

  const itemsTotal = summary.total;
  const order = await pool.query(
    'INSERT INTO orders(user_id,customer_name,phone,address,note,total,status,shipping_method,shipping_fee,items_total,confirmed_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [req.session.user?.id || null, customer_name, phone, address, note || '', itemsTotal, 'new', method, 0, itemsTotal, 0]
  );
  const orderRow = order.rows[0];

  for (const item of cart) {
    const subtotal = Number(item.price) * Number(item.quantity);
    await pool.query('INSERT INTO order_items(order_id,product_id,product_name,price,quantity,subtotal) VALUES($1,$2,$3,$4,$5,$6)', [orderRow.id, item.product_id, item.name, item.price, item.quantity, subtotal]);
    await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.product_id]);
  }

  try {
    await sendZaloOrderNotification({ ...orderRow, items_total: itemsTotal, shipping_method: method });
  } catch (e) { console.error('Zalo send failed:', e.message); }

  req.session.cart = [];
  res.render('order-pending',{ orderId: orderRow.id, shippingMethod: method, itemsTotal: itemsTotal });
});

app.get('/my-orders', requireLogin, async (req,res)=>{
  const orders = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC',[req.session.user.id]);
  res.render('my-orders',{orders:orders.rows});
});

app.get('/admin', requireRole('admin'), async (req,res)=>{
  const counts = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM products'),
    pool.query('SELECT COUNT(*)::int AS count FROM orders'),
    pool.query("SELECT COUNT(*)::int AS count FROM products WHERE approval_status='pending'"),
    pool.query('SELECT COALESCE(SUM(CASE WHEN confirmed_total > 0 THEN confirmed_total ELSE total END),0)::numeric AS total FROM orders')
  ]);
  res.render('admin-dashboard',{ productCount: counts[0].rows[0].count, orderCount: counts[1].rows[0].count, pendingCount: counts[2].rows[0].count, revenue: counts[3].rows[0].total });
});

app.get('/admin/products', requireRole('admin'), async (req,res)=>{
  const products = await pool.query('SELECT p.*, c.name AS category_name, u.name AS seller_name FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users u ON u.id = p.seller_id ORDER BY p.id DESC');
  const categories = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
  const sellers = await pool.query("SELECT id,name FROM users WHERE role='seller' ORDER BY id ASC");
  res.render('admin-products',{products:products.rows,categories:categories.rows,sellers:sellers.rows});
});
app.post('/admin/products', requireRole('admin'), async (req,res)=>{
  const { category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active } = req.body;
  await pool.query('INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active,approval_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved')', [category_id || null, seller_id || null, name, price || 0, sale_price || null, stock || 0, image_url, short_desc, storage_note, is_combo === 'on', is_featured === 'on', is_active === 'on']);
  res.redirect('/admin/products');
});
app.post('/admin/products/:id/delete', requireRole('admin'), async (req,res)=>{ await pool.query('DELETE FROM products WHERE id=$1',[req.params.id]); res.redirect('/admin/products'); });

app.get('/seller/products', requireRole('seller'), async (req,res)=>{
  const products = await pool.query('SELECT * FROM products WHERE seller_id=$1 ORDER BY id DESC',[req.session.user.id]);
  const categories = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
  res.render('seller-products',{products:products.rows,categories:categories.rows});
});
app.post('/seller/products', requireRole('seller'), async (req,res)=>{
  const { category_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active } = req.body;
  await pool.query('INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active,approval_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved')', [category_id || null, req.session.user.id, name, price || 0, sale_price || null, stock || 0, image_url, short_desc, storage_note, is_combo === 'on', is_featured === 'on', false]);
  res.redirect('/seller/products');
});


app.get('/admin/seller-approvals', requireRole('admin'), async (req,res)=>{
  const products = await pool.query(`
    SELECT p.*, c.name AS category_name, u.name AS seller_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN users u ON u.id = p.seller_id
    WHERE p.seller_id IS NOT NULL
    ORDER BY CASE p.approval_status WHEN 'pending' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END, p.id DESC
  `);
  res.render('admin-seller-approvals',{products:products.rows});
});
app.post('/admin/seller-approvals/:id/approve', requireRole('admin'), async (req,res)=>{
  await pool.query("UPDATE products SET approval_status='approved', is_active=true, rejection_note='' WHERE id=$1",[req.params.id]);
  res.redirect('/admin/seller-approvals');
});
app.post('/admin/seller-approvals/:id/reject', requireRole('admin'), async (req,res)=>{
  await pool.query("UPDATE products SET approval_status='rejected', is_active=false, rejection_note=$1 WHERE id=$2",[req.body.rejection_note || '', req.params.id]);
  res.redirect('/admin/seller-approvals');
});
app.post('/admin/seller-approvals/:id/hide', requireRole('admin'), async (req,res)=>{
  await pool.query("UPDATE products SET approval_status='hidden', is_active=false WHERE id=$1",[req.params.id]);
  res.redirect('/admin/seller-approvals');
});

app.get('/admin/orders', requireRole('admin'), async (req,res)=>{
  const orders = await pool.query('SELECT * FROM orders ORDER BY id DESC');
  res.render('admin-orders',{orders:orders.rows});
});
app.post('/admin/orders/:id/update', requireRole('admin'), async (req,res)=>{
  const { status, shipping_fee } = req.body;
  const id = req.params.id;
  const orderRs = await pool.query('SELECT * FROM orders WHERE id=$1 LIMIT 1', [id]);
  if (!orderRs.rowCount) return res.redirect('/admin/orders');
  const order = orderRs.rows[0];
  const ship = Number(shipping_fee || 0);
  const confirmedTotal = Number(order.items_total || order.total || 0) + ship;

  await pool.query(
    'UPDATE orders SET status=$1, shipping_fee=$2, confirmed_total=$3, total=$4 WHERE id=$5',
    [status || order.status, ship, confirmedTotal, confirmedTotal, id]
  );

  if (status === 'confirmed') {
    try {
      await sendZaloOrderNotification({
        ...order,
        status: status,
        shipping_fee: ship,
        total: confirmedTotal,
        items_total: Number(order.items_total || order.total || 0)
      }, 'confirmed');
    } catch (e) { console.error('Zalo confirm send failed:', e.message); }
  }

  res.redirect('/admin/orders');
});

app.get('/admin/cms', requireRole('admin'), async (req,res)=>{
  const cms = await pool.query('SELECT * FROM cms_settings LIMIT 1');
  const banners = await pool.query('SELECT * FROM banners ORDER BY id DESC');
  res.render('admin-cms',{cms:cms.rows[0],banners:banners.rows});
});
app.post('/admin/cms', requireRole('admin'), async (req,res)=>{
  const {
    top_banner, hero_badge, hero_title, hero_desc, cta_primary, cta_secondary, hero_image,
    side_title, side_bullets, free_ship_note, hotline, zalo_link,
    promo_line_1, promo_line_2, promo_line_3, promo_line_4,
    section_featured_title, section_combo_title, section_flash_title,
    shipping_city_note, shipping_nationwide_note
  } = req.body;
  await pool.query(
    `UPDATE cms_settings SET
      top_banner=$1, hero_badge=$2, hero_title=$3, hero_desc=$4, cta_primary=$5, cta_secondary=$6, hero_image=$7,
      side_title=$8, side_bullets=$9, free_ship_note=$10, hotline=$11, zalo_link=$12,
      promo_line_1=$13, promo_line_2=$14, promo_line_3=$15, promo_line_4=$16,
      section_featured_title=$17, section_combo_title=$18, section_flash_title=$19,
      shipping_city_note=$20, shipping_nationwide_note=$21,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=(SELECT id FROM cms_settings LIMIT 1)`,
    [top_banner, hero_badge, hero_title, hero_desc, cta_primary, cta_secondary, hero_image,
     side_title, side_bullets, free_ship_note, hotline, zalo_link,
     promo_line_1, promo_line_2, promo_line_3, promo_line_4,
     section_featured_title, section_combo_title, section_flash_title,
     shipping_city_note, shipping_nationwide_note]
  );
  res.redirect('/admin/cms');
});
app.post('/admin/banners', requireRole('admin'), async (req,res)=>{
  const { title,image_url,link_url,position,is_active } = req.body;
  await pool.query('INSERT INTO banners(title,image_url,link_url,position,is_active) VALUES($1,$2,$3,$4,$5)', [title,image_url,link_url,position || 'home', is_active === 'on']);
  res.redirect('/admin/cms');
});
app.post('/admin/banners/:id/delete', requireRole('admin'), async (req,res)=>{ await pool.query('DELETE FROM banners WHERE id=$1',[req.params.id]); res.redirect('/admin/cms'); });

app.get('/admin/flash-sales', requireRole('admin'), async (req,res)=>{
  const flashSales = await pool.query('SELECT fs.*, p.name FROM flash_sales fs LEFT JOIN products p ON p.id = fs.product_id ORDER BY fs.id DESC');
  const products = await pool.query('SELECT id,name FROM products WHERE is_active=true AND approval_status='approved' ORDER BY id DESC');
  res.render('admin-flash-sales',{flashSales:flashSales.rows,products:products.rows});
});
app.post('/admin/flash-sales', requireRole('admin'), async (req,res)=>{
  const { product_id,sale_price,start_at,end_at,is_active } = req.body;
  await pool.query('INSERT INTO flash_sales(product_id,sale_price,start_at,end_at,is_active) VALUES($1,$2,$3,$4,$5)', [product_id, sale_price || 0, start_at || null, end_at || null, is_active === 'on']);
  res.redirect('/admin/flash-sales');
});

app.get('/health',(req,res)=>res.send('OK'));

(async()=>{ try{ await initDb(); console.log('DB READY'); app.listen(PORT, ()=>console.log('Server running on', PORT)); } catch(e){ console.error(e); process.exit(1); }})();
