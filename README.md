# Prilavok Backend

Backend API for the Prilavok iPad POS and public web menu.

## Environment variables

Set these in Railway Variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Never commit secrets to GitHub.

## Endpoints

- `GET /health` — service health check
- `GET /api/menu` — active online menu from Supabase

The first version intentionally does not create or modify POS data. It only reads the existing `categories` and `products` tables.

## Run locally

```bash
npm install
npm start
```
