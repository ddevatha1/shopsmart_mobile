import express from 'express';
import cors from 'cors';
import type { ErrorRequestHandler } from 'express';
import { handleSearch } from './routes/search.ts';
import { handleProductImage } from './routes/productImage.ts';
import { handleTrip } from './routes/trip.ts';

const app = express();

app.use(cors());
app.use(express.json());

app.post('/api/search', handleSearch);
app.get('/api/product-image', handleProductImage);
app.post('/api/trip', handleTrip);

// express.json() throws a SyntaxError for unparseable bodies — mirror the
// web route's `Invalid JSON body.` response instead of Express's default HTML.
const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON body.' });
    return;
  }
  next(err);
};
app.use(jsonErrorHandler);

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`shopsmart_mobile backend listening on http://localhost:${PORT}`);
});
