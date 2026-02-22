/**
 * Validate Telegram WebApp initData using HMAC-SHA256.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function validateInitData(
  initData: string,
  botToken: string
): Promise<{ valid: boolean; user?: TelegramUser }> {
  if (!initData || !botToken) return { valid: false };

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false };

    params.delete('hash');
    // Sort params alphabetically and join with \n
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256(secret_key, data_check_string)
    // secret_key = HMAC-SHA256("WebAppData", bot_token)
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secretHash = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));

    const validationKey = await crypto.subtle.importKey(
      'raw',
      secretHash,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', validationKey, encoder.encode(dataCheckString));

    const computedHash = Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (computedHash !== hash) return { valid: false };

    // Extract user
    const userStr = params.get('user');
    if (userStr) {
      const user = JSON.parse(userStr) as TelegramUser;
      return { valid: true, user };
    }
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}
