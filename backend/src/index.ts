import express from 'express';
import { projectsRouter } from './routes/projects.js';
import { bodyParseErrorHandler } from './errors.js';

const app = express();

// AC-018:已宣告的操作只在宣告的路徑上提供。express 兩個設定的預設都是
// false —— /Projects、/projects/ 這些沒有寫進 contract 的路徑會回一個
// **宣告過的成功回應**,等於在契約之外長出一片沒有人寫下來、client 卻
// 依賴得到的相容面。
//
// 必須在註冊任何路由之前設定:express 是在第一次 app.use / app.METHOD
// 時才建 router,設定是那個時候讀進去的,之後再改就來不及了。
app.set('case sensitive routing', true);
app.set('strict routing', true);

app.use(express.json());
app.use(projectsRouter);

// 錯誤處理器註冊在最後,但它攔的是 express.json() 在最前面丟出來的錯 ——
// 順序看起來相反,是因為錯誤處理器接的是「它之前註冊的東西」丟出來的例外。
// 少了這一行,語法錯誤的 JSON 會拿到 express 預設的 HTML 400,而 contract
// 說這個 400 的 content 是 application/json 的 Error。
app.use(bodyParseErrorHandler);

const port = Number(process.env.PORT ?? 3000);

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`backend listening on :${port}`);
  });
}

export { app };
