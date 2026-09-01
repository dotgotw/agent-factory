import express from 'express';
import { projectsRouter } from './routes/projects.js';
import { bodyParseErrorHandler } from './errors.js';

const app = express();
app.use(express.json());
app.use('/projects', projectsRouter);

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
