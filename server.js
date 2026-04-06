require('dotenv').config();
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const pool = require('./modules/db');
const { initDb } = require('./modules/initDb');
const { sendZaloOrderNotification } = require('./modules/zalo');

const app = express();
const PORT = process.env.PORT || 10000;

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

async function checkSpamOrder(phone){
  const rs = await pool.query('SELECT created_at FROM orders WHERE phone=$1 ORDER BY id DESC LIMIT 1', [phone]);
  if (!rs.rowCount) return false;
  return (new Date() - new Date(rs.rows[0].created_at)) < 60000;
}

app.get('/', async (req,res)=>{
  const categories = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
  const banners = await pool.query("SELECT * FROM banners WHERE is_active=true AND position='home' ORDER BY id ASC");
  const featured = await pool.query('SELECT * FROM products WHERE is_featured=true AND is_active=true ORDER BY id DESC LIMIT 8');
  const combos = await pool.query('SELECT * FROM products WHERE is_combo=true AND is_active=true ORDER BY id DESC LIMIT 6');
  const flashSales = await pool.query(`
    SELECT fs.*, p.name, p.image_url, p.price AS original_price, p.id AS product_id
    FROM flash_sales fs JOIN products p ON p.id=fs.product_id
    WHERE fs.is_active=true AND p.is_active=true
      AND (fs.start_at IS NULL OR fs.start_at <= CURRENT_TIMESTAMP)
      AND (fs.end_at IS NULL OR fs.end_at >= CURRENT_TIMESTAMP)
    ORDER BY fs.id DESC
  `);
  res.render('home',{ categories: categories.rows, banners: banners.rows, featured: featured.rows, combos: combos.rows, flashSales: flashSales.rows });
});

app.get('/category/:slug', async (req,res)=>{
  const category = await pool.query('SELECT * FROM categories WHERE slug=$1 LIMIT 1', [req.params.slug]);
  if (!category.rowCount) return res.status(404).send('Không tìm thấy danh mục');
  const products = await pool.query('SELECT * FROM products WHERE category_id=$1 AND is_active=true ORDER BY id DESC', [category.rows[0].id]);
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
  const p = await pool.query('SELECT * FROM products WHERE id=$1 AND is_active=true LIMIT 1',[req.params.id]);
  if(!p.rowCount) return res.redirect('/');
  const product = p.rows[0];
  if(Number(product.stock) <= 0) return res.send('Sản phẩm đã hết hàng');
  const cart = req.session.cart || [];
  const found = cart.find(i => i.product_id === Number(product.id));
  const price = Number(product.sale_price || product.price || 0);
  if(found){
    if(found.quantity < Number(product.stock)) found.quantity += 1;
  } else {
    cart.push({ product_id: Number(product.id), name: product.name, price, image_url: product.image_url, quantity: 1 });
  }
  req.session.cart = cart;
  res.redirect('/cart');
});

app.get('/cart',(req,res)=>{
  const cart = req.session.cart || [];
  const total = cart.reduce((s,i)=>s + Number(i.price) * Number(i.quantity), 0);
  res.render('cart',{ cart, total });
});

app.post('/cart/remove/:id',(req,res)=>{
  req.session.cart = (req.session.cart || []).filter(i => i.product_id !== Number(req.params.id));
  res.redirect('/cart');
});

app.get('/checkout',(req,res)=>{
  const cart = req.session.cart || [];
  if(!cart.length) return res.redirect('/cart');
  const total = cart.reduce((s,i)=>s + Number(i.price) * Number(i.quantity), 0);
  res.render('checkout',{ cart, total, error:'' });
});

app.post('/checkout', async (req,res)=>{
  const cart = req.session.cart || [];
  const total = cart.reduce((s,i)=>s + Number(i.price) * Number(i.quantity), 0);
  const { customer_name, phone, address, note } = req.body;

  if(!cart.length) return res.redirect('/cart');
  if(!customer_name || !phone || !address) return res.render('checkout',{cart,total,error:'Vui lòng nhập đủ họ tên, số điện thoại, địa chỉ.'});
  if(await checkSpamOrder(phone)) return res.render('checkout',{cart,total,error:'Bạn đặt hàng quá nhanh. Vui lòng thử lại sau 1 phút.'});

  for (const item of cart) {
    const p = await pool.query('SELECT stock FROM products WHERE id=$1 LIMIT 1',[item.product_id]);
    if(!p.rowCount || Number(p.rows[0].stock) < Number(item.quantity)) return res.render('checkout',{cart,total,error:'Có sản phẩm không đủ tồn kho. Vui lòng kiểm tra lại giỏ hàng.'});
  }

  const order = await pool.query(
    'INSERT INTO orders(user_id,customer_name,phone,address,note,total,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.session.user?.id || null, customer_name, phone, address, note || '', total, 'new']
  );
  const orderRow = order.rows[0];

  for (const item of cart) {
    const subtotal = Number(item.price) * Number(item.quantity);
    await pool.query('INSERT INTO order_items(order_id,product_id,product_name,price,quantity,subtotal) VALUES($1,$2,$3,$4,$5,$6)', [orderRow.id, item.product_id, item.name, item.price, item.quantity, subtotal]);
    await pool.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, item.product_id]);
  }

  try { await sendZaloOrderNotification(orderRow); } catch (e) { console.error('Zalo send failed:', e.message); }

  req.session.cart = [];
  res.render('order-success',{ orderId: orderRow.id });
});

app.get('/my-orders', requireLogin, async (req,res)=>{
  const orders = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC',[req.session.user.id]);
  res.render('my-orders',{orders:orders.rows});
});

app.get('/admin', requireRole('admin'), async (req,res)=>{
  const counts = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM products'),
    pool.query('SELECT COUNT(*)::int AS count FROM orders'),
    pool.query('SELECT COUNT(*)::int AS count FROM flash_sales WHERE is_active=true'),
    pool.query('SELECT COALESCE(SUM(total),0)::numeric AS total FROM orders')
  ]);
  res.render('admin-dashboard',{ productCount: counts[0].rows[0].count, orderCount: counts[1].rows[0].count, flashCount: counts[2].rows[0].count, revenue: counts[3].rows[0].total });
});

app.get('/admin/products', requireRole('admin'), async (req,res)=>{
  const products = await pool.query('SELECT p.*, c.name AS category_name, u.name AS seller_name FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users u ON u.id = p.seller_id ORDER BY p.id DESC');
  const categories = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, id ASC');
  const sellers = await pool.query("SELECT id,name FROM users WHERE role='seller' ORDER BY id ASC");
  res.render('admin-products',{products:products.rows,categories:categories.rows,sellers:sellers.rows});
});
app.post('/admin/products', requireRole('admin'), async (req,res)=>{
  const { category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active } = req.body;
  await pool.query('INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [category_id || null, seller_id || null, name, price || 0, sale_price || null, stock || 0, image_url, short_desc, storage_note, is_combo === 'on', is_featured === 'on', is_active === 'on']);
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
  await pool.query('INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [category_id || null, req.session.user.id, name, price || 0, sale_price || null, stock || 0, image_url, short_desc, storage_note, is_combo === 'on', is_featured === 'on', is_active === 'on']);
  res.redirect('/seller/products');
});

app.get('/admin/orders', requireRole('admin'), async (req,res)=>{
  const orders = await pool.query('SELECT * FROM orders ORDER BY id DESC');
  res.render('admin-orders',{orders:orders.rows});
});
app.post('/admin/orders/:id/status', requireRole('admin'), async (req,res)=>{ await pool.query('UPDATE orders SET status=$1 WHERE id=$2',[req.body.status, req.params.id]); res.redirect('/admin/orders'); });

app.get('/admin/cms', requireRole('admin'), async (req,res)=>{
  const cms = await pool.query('SELECT * FROM cms_settings LIMIT 1');
  const banners = await pool.query('SELECT * FROM banners ORDER BY id DESC');
  res.render('admin-cms',{cms:cms.rows[0],banners:banners.rows});
});
app.post('/admin/cms', requireRole('admin'), async (req,res)=>{
  const { top_banner,hero_badge,hero_title,hero_desc,cta_primary,cta_secondary,hero_image,side_title,side_bullets,free_ship_note,hotline,zalo_link } = req.body;
  await pool.query('UPDATE cms_settings SET top_banner=$1,hero_badge=$2,hero_title=$3,hero_desc=$4,cta_primary=$5,cta_secondary=$6,hero_image=$7,side_title=$8,side_bullets=$9,free_ship_note=$10,hotline=$11,zalo_link=$12,updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT id FROM cms_settings LIMIT 1)', [top_banner,hero_badge,hero_title,hero_desc,cta_primary,cta_secondary,hero_image,side_title,side_bullets,free_ship_note,hotline,zalo_link]);
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
  const products = await pool.query('SELECT id,name FROM products WHERE is_active=true ORDER BY id DESC');
  res.render('admin-flash-sales',{flashSales:flashSales.rows,products:products.rows});
});
app.post('/admin/flash-sales', requireRole('admin'), async (req,res)=>{
  const { product_id,sale_price,start_at,end_at,is_active } = req.body;
  await pool.query('INSERT INTO flash_sales(product_id,sale_price,start_at,end_at,is_active) VALUES($1,$2,$3,$4,$5)', [product_id, sale_price || 0, start_at || null, end_at || null, is_active === 'on']);
  res.redirect('/admin/flash-sales');
});

app.get('/health',(req,res)=>res.send('OK'));

(async()=>{ try{ await initDb(); console.log('DB READY'); app.listen(PORT, ()=>console.log('Server running on', PORT)); } catch(e){ console.error(e); process.exit(1); }})();
