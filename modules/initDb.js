const pool = require('./db');

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
      INSERT INTO products(category_id,seller_id,name,price,sale_price,stock,image_url,short_desc,storage_note,is_combo,is_featured,is_active) VALUES
      ($1,$6,'SƯỜN TỨ QUÝ 500g',195000,195000,25,'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?q=80&w=1000&auto=format&fit=crop','Sườn ướp sẵn đậm vị','Bảo quản ngăn đông',false,true,true),
      ($2,$6,'Combo gia đình 1kg',299000,259000,20,'https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=1000&auto=format&fit=crop','Combo tiện lợi cho 3-4 người','Giữ lạnh 0-4°C',true,true,true),
      ($3,$6,'Ba chỉ cuộn cấp đông',129000,109000,40,'https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?q=80&w=1000&auto=format&fit=crop','Đóng gói sạch, dễ chế biến','Bảo quản ngăn đông',false,false,true),
      ($4,$6,'Cơm cháy chà bông',59000,NULL,60,'https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=1000&auto=format&fit=crop','Ăn nhanh, tiện lợi','Nơi khô ráo',false,false,true),
      ($5,$6,'Gà ướp mật ong',189000,159000,18,'https://images.unsplash.com/photo-1527477396000-e27163b481c2?q=80&w=1000&auto=format&fit=crop','Món hot khuyến mãi hôm nay','Bảo quản ngăn mát',false,true,true)
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

module.exports = { initDb };
