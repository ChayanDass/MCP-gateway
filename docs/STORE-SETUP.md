# Store setup (WooCommerce, standard tooling only)

The store is configured with WP-CLI and WooCommerce's own commands and options.
No custom code is used. Run the commands inside the WordPress pod as `www-data`:

```sh
POD=$(kubectl get pod -n kube-mcp -l app.kubernetes.io/component=wordpress -o jsonpath='{.items[0].metadata.name}')
kubectl exec -it -n kube-mcp $POD -c wordpress -- \
  runuser -u www-data -- php /usr/local/bin/wp --path=/var/www/html <command>
```

WP-CLI is not in the WordPress image. Copy the official `wp-cli.phar` to
`/usr/local/bin/wp` in the pod first (see the README).

## 1. WordPress

```sh
wp option update blogname 'Harbor & Hearth'
wp option update blogdescription 'Small-batch home goods'
wp option update timezone_string 'America/Los_Angeles'
wp rewrite structure '/%postname%/' --hard
wp option update users_can_register 1          # customers can register
wp option update default_role customer
wp theme install storefront --activate
```

## 2. WooCommerce store

```sh
wp option update woocommerce_coming_soon no    # open the store (default is "yes")
wp option update woocommerce_store_address '1 Market St'
wp option update woocommerce_store_city 'San Francisco'
wp option update woocommerce_store_postcode '94105'
wp option update woocommerce_default_country 'US:CA'
wp option update woocommerce_currency 'USD'
wp option update woocommerce_weight_unit 'kg'
wp option update woocommerce_dimension_unit 'cm'
wp option update woocommerce_manage_stock 'yes'
wp option update woocommerce_calc_taxes 'no'
wp option update woocommerce_enable_reviews 'yes'
wp option update woocommerce_enable_guest_checkout 'yes'
wp option update woocommerce_enable_myaccount_registration 'yes'
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp wc tool run install_pages --user=admin      # Shop, Cart, Checkout, My account
```

## 3. Payments

```sh
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay when your order arrives."}' --format=json
wp option update woocommerce_bacs_settings '{"enabled":"yes","title":"Direct bank transfer","description":"Demo store: no real bank account is connected."}' --format=json
```

## 4. Shipping

```sh
wp wc shipping_zone_method create 0 --method_id=flat_rate --enabled=1 --user=admin
wp option update woocommerce_flat_rate_settings '{"cost":"5"}' --format=json
```

## 5. Products (WooCommerce sample data)

WooCommerce ships `sample_products.xml`. Import it with the official WordPress importer:

```sh
wp plugin install wordpress-importer --activate
wp import /var/www/html/wp-content/plugins/woocommerce/sample-data/sample_products.xml --authors=create
```

This adds 18 products (simple, variable, grouped, external and downloadable).

Note: the "Album" downloadable product's file URL is not in WooCommerce's approved
download directories, so it may not be downloadable.

## 6. Verify

- Storefront: http://store.localtest.me:8080 (products on `/shop/`)
- Admin: http://store.localtest.me:8080/wp-admin/ (user `admin`; password in the `wp-admin-password` Secret)
- Account: http://store.localtest.me:8080/my-account/ (login and registration)
- Orders: WooCommerce > Orders, or `wp wc shop_order list --user=admin`

## Customer checkout (verified)

Cash on delivery through the Store API creates an order with status `processing`.
The admin can then change its status (`completed`, etc.) under WooCommerce > Orders.

## Not done (out of scope)

- Email delivery: the container has no `sendmail`, so WooCommerce's order emails fail.
- REST API keys: needed for the MCP server. They are created in WooCommerce > Settings > Advanced > REST API.
