const https = require('https');

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

module.exports = { sendZaloOrderNotification };
