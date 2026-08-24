<?php
/**
 * Admin settings screen: API base URL + API key. The key is stored in
 * wp_options, readable only by users with `manage_options` (standard
 * WordPress practice for plugin-held API credentials - see e.g. how
 * core's REST API application passwords and popular plugins like Akismet
 * store their key) and is never sent to the browser after being saved:
 * the REST proxy (class-clinic-booking-rest-proxy.php) reads it
 * server-side only.
 *
 * @package ClinicBookingWidget
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Clinic_Booking_Settings {

	const OPTION_GROUP    = 'clinic_booking_settings';
	const OPTION_API_URL  = 'clinic_booking_api_base_url';
	const OPTION_API_KEY  = 'clinic_booking_api_key';
	const OPTION_CLINIC   = 'clinic_booking_default_clinic_id';

	public static function register_menu() {
		add_options_page(
			__( 'Clinic Booking', 'clinic-booking-widget' ),
			__( 'Clinic Booking', 'clinic-booking-widget' ),
			'manage_options',
			'clinic-booking-widget',
			array( __CLASS__, 'render_page' )
		);
	}

	public static function register_settings() {
		register_setting(
			self::OPTION_GROUP,
			self::OPTION_API_URL,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( __CLASS__, 'sanitize_base_url' ),
				'default'           => '',
			)
		);
		register_setting(
			self::OPTION_GROUP,
			self::OPTION_API_KEY,
			array(
				'type'              => 'string',
				'sanitize_callback' => 'sanitize_text_field',
				'default'           => '',
			)
		);
		register_setting(
			self::OPTION_GROUP,
			self::OPTION_CLINIC,
			array(
				'type'              => 'string',
				'sanitize_callback' => 'sanitize_text_field',
				'default'           => '',
			)
		);

		add_settings_section(
			'clinic_booking_main',
			__( 'Booking API connection', 'clinic-booking-widget' ),
			function () {
				echo '<p>' . esc_html__( 'Generate an API key from the clinic admin dashboard (Integrations page) and paste it here.', 'clinic-booking-widget' ) . '</p>';
			},
			'clinic-booking-widget'
		);

		add_settings_field(
			self::OPTION_API_URL,
			__( 'API base URL', 'clinic-booking-widget' ),
			array( __CLASS__, 'render_api_url_field' ),
			'clinic-booking-widget',
			'clinic_booking_main'
		);
		add_settings_field(
			self::OPTION_API_KEY,
			__( 'API key', 'clinic-booking-widget' ),
			array( __CLASS__, 'render_api_key_field' ),
			'clinic-booking-widget',
			'clinic_booking_main'
		);
		add_settings_field(
			self::OPTION_CLINIC,
			__( 'Default clinic ID', 'clinic-booking-widget' ),
			array( __CLASS__, 'render_clinic_field' ),
			'clinic-booking-widget',
			'clinic_booking_main'
		);
	}

	public static function sanitize_base_url( $value ) {
		$value = untrailingslashit( trim( (string) $value ) );
		return esc_url_raw( $value );
	}

	public static function render_api_url_field() {
		$value = get_option( self::OPTION_API_URL, '' );
		printf(
			'<input type="url" name="%1$s" value="%2$s" class="regular-text" placeholder="https://api.your-clinic.example" />',
			esc_attr( self::OPTION_API_URL ),
			esc_attr( $value )
		);
	}

	public static function render_api_key_field() {
		$value    = get_option( self::OPTION_API_KEY, '' );
		$has_key  = '' !== $value;
		$display  = $has_key ? str_repeat( '•', 8 ) . substr( $value, -4 ) : '';
		echo '<input type="password" name="' . esc_attr( self::OPTION_API_KEY ) . '" value="' . esc_attr( $value ) . '" class="regular-text" autocomplete="off" placeholder="sk_live_..." />';
		if ( $has_key ) {
			echo '<p class="description">' . esc_html( sprintf( /* translators: %s: masked key */ __( 'Currently set: %s', 'clinic-booking-widget' ), $display ) ) . '</p>';
		}
	}

	public static function render_clinic_field() {
		$value = get_option( self::OPTION_CLINIC, '' );
		printf(
			'<input type="text" name="%1$s" value="%2$s" class="regular-text" placeholder="%3$s" />',
			esc_attr( self::OPTION_CLINIC ),
			esc_attr( $value ),
			esc_attr__( 'Leave blank to let patients choose a clinic', 'clinic-booking-widget' )
		);
		echo '<p class="description">' . esc_html__( 'Optional. Find clinic IDs in the admin dashboard\'s Clinics page.', 'clinic-booking-widget' ) . '</p>';
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Clinic Booking Widget', 'clinic-booking-widget' ); ?></h1>
			<p><?php esc_html_e( 'Use the [clinic_booking] shortcode on any page or post to embed the booking widget.', 'clinic-booking-widget' ); ?></p>
			<form action="options.php" method="post">
				<?php
				settings_fields( self::OPTION_GROUP );
				do_settings_sections( 'clinic-booking-widget' );
				submit_button( __( 'Save settings', 'clinic-booking-widget' ) );
				?>
			</form>
		</div>
		<?php
	}

	public static function get_api_base_url() {
		return get_option( self::OPTION_API_URL, '' );
	}

	public static function get_api_key() {
		return get_option( self::OPTION_API_KEY, '' );
	}

	public static function get_default_clinic_id() {
		return get_option( self::OPTION_CLINIC, '' );
	}

	public static function is_configured() {
		return '' !== self::get_api_base_url() && '' !== self::get_api_key();
	}
}
