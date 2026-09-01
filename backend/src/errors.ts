import type { NextFunction, Request, Response } from 'express';
import type { components } from '@af/contract';

type ApiError = components['schemas']['Error'];

/**
 * body-parser 丟出來的錯誤:http-errors 補上 status,body-parser 自己補上
 * type(entity.parse.failed、request.aborted、entity.too.large …)。
 * 兩個欄位都不在 Error 的型別裡,所以宣告成 unknown 再自己收窄。
 */
interface BodyParserError extends Error {
  type?: unknown;
  status?: unknown;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return err instanceof Error && typeof (err as BodyParserError).type === 'string';
}

/**
 * 把 body-parser 的 400 轉成 contract 說好的 Error schema。
 *
 * 語法錯誤的 JSON 在 `express.json()` 裡就丟出來了 —— 請求根本走不到路由,
 * 於是路由裡那些驗證(必填、enum、未定義欄位)一個都沒機會跑,express 的
 * 預設錯誤處理器回一個 HTML 頁面。狀態碼是對的,但 contract 說這個 400 的
 * content 是 application/json 的 Error,而 HTML 給不出 code
 * (CR-012 把 code 收成 enum 之後更刺眼)。
 *
 * 所以這件事只能在錯誤處理器裡修,不能在路由裡修。**它在 express 的註冊
 * 順序是最後,但它攔的是管線最前面丟出來的錯** —— 錯誤處理器接的是它
 * 「之前」註冊的東西丟出來的例外,不是它之後的。
 *
 * 只接 status 400 的那些:那正是 contract 在這些端點上宣告過的回應。
 * 413(body 太大)、415(編碼不支援)這些 contract 沒有宣告,把它們改寫成
 * 400 會是謊報狀態碼,交還給 express 預設處理。見 PR 說明裡的那段但書。
 */
export function bodyParseErrorHandler(
  err: unknown,
  _req: Request,
  res: Response<ApiError>,
  next: NextFunction,
): void {
  if (!isBodyParserError(err) || err.status !== 400) {
    next(err);
    return;
  }

  // 解析失敗與「body 根本沒讀完」是兩件事,訊息別混為一談。
  const message =
    err.type === 'entity.parse.failed'
      ? `body 不是合法的 JSON:${err.message}`
      : `無法讀取 request body:${err.message}`;

  res.status(400).json({ code: 'VALIDATION_ERROR', message });
}
