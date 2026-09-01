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
  /** raw-body 在 entity.too.large 時附上的位元組上限。 */
  limit?: unknown;
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
 * 接的是 contract 在這些端點上宣告過的回應,一個狀態碼對一個 code:
 *
 *   400 → VALIDATION_ERROR    body 讀不到或不是合法的 JSON
 *   413 → PAYLOAD_TOO_LARGE   body 超過大小上限(contract 2.2.0 新增)
 *
 * 413 值得一個自己的 code,不併進 VALIDATION_ERROR:把「你的 body 有 200KB」
 * 說成驗證失敗,等於叫 client 去改欄位,而它該做的是少送一點。
 *
 * 其餘(415 編碼不支援之類)contract 沒有宣告,改寫成已宣告的狀態碼會是
 * 謊報,交還 express 預設處理。
 */
export function bodyParseErrorHandler(
  err: unknown,
  _req: Request,
  res: Response<ApiError>,
  next: NextFunction,
): void {
  if (!isBodyParserError(err)) {
    next(err);
    return;
  }

  if (err.status === 413) {
    // 上限的數值不在 contract 裡(那是部署選擇),但講給 client 聽是免費的
    // —— 它要做的事是「少送一點」,不知道界線在哪就只能猜。
    const limit = typeof err.limit === 'number' ? `,上限 ${err.limit} bytes` : '';
    res.status(413).json({
      code: 'PAYLOAD_TOO_LARGE',
      message: `request body 超過伺服器允許的大小${limit}`,
    });
    return;
  }

  if (err.status === 400) {
    // 解析失敗與「body 根本沒讀完」是兩件事,訊息別混為一談。
    const message =
      err.type === 'entity.parse.failed'
        ? `body 不是合法的 JSON:${err.message}`
        : `無法讀取 request body:${err.message}`;

    res.status(400).json({ code: 'VALIDATION_ERROR', message });
    return;
  }

  next(err);
}
