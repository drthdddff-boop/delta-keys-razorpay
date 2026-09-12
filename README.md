# DELTA.KEYS — clean Razorpay version

This version uses Razorpay Standard Checkout with server-side signature verification and payment-status verification. It does NOT require a Razorpay webhook.

Railway Variables:
- RAZORPAY_KEY_ID = your Razorpay Test Mode Key ID
- RAZORPAY_KEY_SECRET = your Razorpay Test Mode Key Secret
- ADMIN_USER = your admin username
- ADMIN_PASSWORD = your admin password

The server also accepts RAZORPAY_KEY and RAZORPAY_PUBLIC_KEY as aliases for the Key ID, and RAZORPAY_SECRET as an alias for the secret.

Important: Razorpay credentials are still required. No ZIP can make Razorpay work without valid credentials on the deployed server.

Start: npm start
Store: /
Admin: /admin
Health check: /api/health
