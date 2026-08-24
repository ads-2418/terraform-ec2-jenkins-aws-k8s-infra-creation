<?php
/**
 * Plugin Name: Clinic Booking Widget
 * Description: Embeds the clinic's appointment booking widget via the [clinic_booking] shortcode. A thin client only - all availability computation, double-booking prevention, and appointment state live in the booking API; this plugin never decides any of that itself (docs/API.md §5, docs/ARCHITECTURE.md §1).
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 * Text Domain: clinic-booking-widget
 *
 * @package ClinicBookingWidget
 */

// Exit if accessed directly - standard WordPress plugin guard.
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CLINIC_BOOKING_VERSION', '0.1.0' );
define( 'CLINIC_BOOKING_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'CLINIC_BOOKING_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once CLINIC_BOOKING_PLUGIN_DIR . 'includes/class-clinic-booking-settings.php';
require_once CLINIC_BOOKING_PLUGIN_DIR . 'includes/class-clinic-booking-api-client.php';
require_once CLINIC_BOOKING_PLUGIN_DIR . 'includes/class-clinic-booking-rest-proxy.php';
require_once CLINIC_BOOKING_PLUGIN_DIR . 'includes/class-clinic-booking-shortcode.php';

add_action( 'init', array( 'Clinic_Booking_Shortcode', 'register' ) );
add_action( 'admin_menu', array( 'Clinic_Booking_Settings', 'register_menu' ) );
add_action( 'admin_init', array( 'Clinic_Booking_Settings', 'register_settings' ) );
add_action( 'rest_api_init', array( 'Clinic_Booking_Rest_Proxy', 'register_routes' ) );
