<?php
/**
 * The [clinic_booking] shortcode: renders an empty mount point and
 * enqueues the widget JS/CSS, handing the widget the REST proxy URL, a
 * nonce, and the configured default clinic ID. All booking behavior lives
 * in assets/booking-widget.js, which talks only to this plugin's own
 * REST proxy - never directly to the booking API (the API key must never
 * reach the browser).
 *
 * @package ClinicBookingWidget
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Clinic_Booking_Shortcode {

	public static function register() {
		add_shortcode( 'clinic_booking', array( __CLASS__, 'render' ) );
	}

	public static function render( $atts ) {
		$atts = shortcode_atts(
			array(
				'clinic_id' => '',
			),
			$atts,
			'clinic_booking'
		);

		if ( ! Clinic_Booking_Settings::is_configured() ) {
			if ( current_user_can( 'manage_options' ) ) {
				return '<p>' . esc_html__( 'Clinic Booking Widget: please set the API URL and key under Settings → Clinic Booking.', 'clinic-booking-widget' ) . '</p>';
			}
			return '';
		}

		wp_enqueue_style(
			'clinic-booking-widget',
			CLINIC_BOOKING_PLUGIN_URL . 'assets/booking-widget.css',
			array(),
			CLINIC_BOOKING_VERSION
		);
		wp_enqueue_script(
			'clinic-booking-widget',
			CLINIC_BOOKING_PLUGIN_URL . 'assets/booking-widget.js',
			array(),
			CLINIC_BOOKING_VERSION,
			true
		);

		$clinic_id = '' !== $atts['clinic_id'] ? $atts['clinic_id'] : Clinic_Booking_Settings::get_default_clinic_id();

		wp_localize_script(
			'clinic-booking-widget',
			'ClinicBookingConfig',
			array(
				'restUrl'  => esc_url_raw( rest_url( Clinic_Booking_Rest_Proxy::NAMESPACE_ ) ),
				'nonce'    => wp_create_nonce( 'wp_rest' ),
				'clinicId' => sanitize_text_field( $clinic_id ),
			)
		);

		$mount_id = 'clinic-booking-widget-' . wp_unique_id();
		return '<div id="' . esc_attr( $mount_id ) . '" class="clinic-booking-widget" data-clinic-booking-root></div>';
	}
}
