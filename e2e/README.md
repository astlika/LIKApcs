# End-to-end checks (phone and tablet, real server and PostgreSQL)

Run these from a machine with PostgreSQL, a running LIKApcs Server on port 4700 and the built
`/phone/` and `/tab/` apps. Test data only: never run against a shop's real database.

1. `node e2e/seed.mjs` creates the owner, 6 PCs, products, a customer and an open cash shift.
2. `node e2e/users.mjs` creates the phone user `telefon` (e-mail `telefon@test.local`) and a cashier.
3. `python3 e2e/smoke.py` opens every page on 6 screen sizes (360 px to 1366 px) and reports
   console errors, horizontal overflow, touch targets under 44 px and suspicious texts.
4. `python3 e2e/flow_sales.py phone 390 844` and `python3 e2e/flow_sales.py tab 1024 768` make real
   sales through the UI and check the total, the payments and the change in the database.

Needs: `pip install playwright` and `python3 -m playwright install chromium`.
