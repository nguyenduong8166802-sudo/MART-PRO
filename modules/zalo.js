const https = require('https');

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
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

async function sendZaloOrderNotification(order) {
  const accessToken = process.env.ZALO_OA_ACCESS_TOKEN;
  const recipientUserId = process.env.ZALO_RECIPIENT_USER_ID;
  if (!accessToken || !recipientUserId) return { ok: false, skipped: true };

  const text = [
    'ĐƠN HÀNG MỚI',
    `Mã đơn: #${order.id}`,
    `Khách: ${order.customer_name}`,
    `SĐT: ${order.phone}`,
    `Địa chỉ: ${order.address}`,
    `Tổng tiền: ${Number(order.total).toLocaleString('vi-VN')}đ`,
    order.note ? `Ghi chú: ${order.note}` : ''
  ].filter(Boolean).join('\n');

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
