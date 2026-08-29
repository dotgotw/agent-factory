import express from 'express';
import { projectsRouter } from './routes/projects.js';

const app = express();
app.use(express.json());
app.use('/projects', projectsRouter);

const port = Number(process.env.PORT ?? 3000);

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`backend listening on :${port}`);
  });
}

export { app };
