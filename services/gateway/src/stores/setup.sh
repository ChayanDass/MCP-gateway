#!/bin/sh
set -eu
W="wp --path=/var/www/html"

echo "waiting for WordPress to write wp-config.php"
i=0
until [ -f /var/www/html/wp-config.php ]; do
  i=$((i+1)); [ "$i" -gt 120 ] && { echo "timed out waiting for wp-config.php"; exit 1; }
  sleep 5
done
until $W db check >/dev/null 2>&1; do sleep 3; done

if ! $W core is-installed 2>/dev/null; then
  $W core install --url="$SITE_URL" --title="$STORE_TITLE" \
    --admin_user=admin --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$STORE_ADMIN_EMAIL" --skip-email
fi
# An "admin" user may be missing if an earlier install used another name.
if ! $W user get admin >/dev/null 2>&1; then
  $W user create admin "$STORE_ADMIN_EMAIL" --role=administrator --user_pass="$WP_ADMIN_PASSWORD"
fi

# Pretty permalinks. WP-CLI has no Apache, so it cannot see mod_rewrite and
# writes an empty .htaccess. Write the standard WordPress rules ourselves.
$W rewrite structure '/%postname%/' --hard >/dev/null 2>&1 || true
if ! grep -q "RewriteRule . /index.php" /var/www/html/.htaccess 2>/dev/null; then
  cat > /var/www/html/.htaccess <<'HTACCESS'
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
HTACCESS
fi

$W plugin is-installed woocommerce 2>/dev/null || $W plugin install woocommerce --activate
$W plugin is-active woocommerce 2>/dev/null || $W plugin activate woocommerce

# Store identity and open shop.
$W option update blogname "$STORE_TITLE"
$W option update woocommerce_coming_soon no
$W option update woocommerce_store_address '1 Market St'
$W option update woocommerce_store_city 'San Francisco'
$W option update woocommerce_store_postcode '94105'
$W option update woocommerce_default_country 'US:CA'
$W option update woocommerce_currency 'USD'
$W option update woocommerce_weight_unit 'kg'
$W option update woocommerce_dimension_unit 'cm'
$W option update woocommerce_manage_stock 'yes'
$W option update woocommerce_calc_taxes 'no'
$W option update woocommerce_enable_guest_checkout 'yes'
$W option update woocommerce_onboarding_profile '{"skipped":true}' --format=json

# Customers can register and choose their own password. Email is not
# available in this cluster, so WooCommerce must not generate one.
$W option update users_can_register 1
$W option update default_role customer
$W option update woocommerce_enable_myaccount_registration yes
$W option update woocommerce_registration_generate_password no

# Payments.
$W option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay when your order arrives."}' --format=json

$W wc tool run install_pages --user=admin >/dev/null 2>&1 || true

# Flat-rate shipping for the default zone, only when the zone has none.
if ! $W wc shipping_zone_method list 0 --user=admin --format=json | grep -q flat_rate; then
  id=$($W wc shipping_zone_method create 0 --method_id=flat_rate --enabled=1 --user=admin --porcelain)
  $W option update "woocommerce_flat_rate_${id}_settings" '{"cost":"5"}' --format=json
fi

# WooCommerce's sample catalogue (18 products), only on an empty store.
if [ "$($W post list --post_type=product --format=count)" = "0" ]; then
  $W plugin install wordpress-importer --activate
  $W import /var/www/html/wp-content/plugins/woocommerce/sample-data/sample_products.xml --authors=create
fi

# Register the REST key the MCP server uses. Only a hash of the consumer key
# is stored, as WooCommerce does itself. Idempotent.
$W eval '
  global $wpdb;
  $ck = getenv("WOO_CONSUMER_KEY");
  $cs = getenv("WOO_CONSUMER_SECRET");
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $hash = hash_hmac("sha256", $ck, "wc-api");
  $exists = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key = %s", $hash));
  if (!$exists) {
    $admin = get_user_by("login", "admin");
    $wpdb->insert($table, array(
      "user_id" => $admin ? $admin->ID : 1,
      "description" => "mcp woo-mcp",
      "permissions" => "read_write",
      "consumer_key" => $hash,
      "consumer_secret" => $cs,
      "truncated_key" => substr($ck, -7),
    ));
  }'

echo "store setup finished: $SITE_URL"
