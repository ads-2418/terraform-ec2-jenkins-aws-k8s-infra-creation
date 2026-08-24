<?php
/**
 * REST routes the widget's JS talks to (namespace `clinic-booking/v1`).
 * Every route is a direct proxy to one booking-API endpoint - no
 * availability computation, no hold-TTL logic, no appointment state
 * decisions happen here (docs/API.md §5). The only things this layer adds
 * are: attaching the API key server-side (class-clinic-booking-api-client.php),
 * and a same-origin nonce check on the mutating routes so a page on
 * another site can't silently book/cancel appointments through a
 * logged-out visitor's browser.
 *
 * @package ClinicBookingWidget
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Clinic_Booking_Rest_Proxy {

	const NAMESPACE_ = 'clinic-booking/v1';

	public static function register_routes() {
		register_rest_route(
			self::NAMESPACE_,
			'/clinics',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'get_clinics' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::NAMESPACE_,
			'/doctors',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'get_doctors' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::NAMESPACE_,
			'/services',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'get_services' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::NAMESPACE_,
			'/available-doctors',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'get_available_doctors' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::NAMESPACE_,
			'/availability',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'get_availability' ),
				'permission_callback' => '__return_true',
			)
		);

		register_rest_route(
			self::NAMESPACE_,
			'/hold',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'post_hold' ),
				'permission_callback' => array( __CLASS__, 'verify_nonce' ),
			)
		);

		register_rest_route(
			self::NAMESPACE_,
			'/confirm',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'post_confirm' ),
				'permission_callback' => array( __CLASS__, 'verify_nonce' ),
			)
		);

		register_rest_route(
			self::NAMESPACE_,
			'/cancel',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'post_cancel' ),
				'permission_callback' => array( __CLASS__, 'verify_nonce' ),
			)
		);
	}

	/**
	 * The `wp_rest` nonce works for anonymous visitors too (it's tied to
	 * the browser's session, not a logged-in user) - this is the standard
	 * WordPress way to confirm a REST request actually originated from a
	 * page this site rendered, not a cross-site form/script.
	 */
	public static function verify_nonce( $request ) {
		$nonce = $request->get_header( 'X-WP-Nonce' );
		if ( ! $nonce || ! wp_verify_nonce( $nonce, 'wp_rest' ) ) {
			return new WP_Error( 'clinic_booking_bad_nonce', __( 'Session expired - please reload the page and try again.', 'clinic-booking-widget' ), array( 'status' => 403 ) );
		}
		return true;
	}

	private static function to_response( $result ) {
		if ( $result['error'] ) {
			return new WP_REST_Response( array( 'error' => array( 'message' => $result['error'] ) ), 502 );
		}
		return new WP_REST_Response( $result['body'], $result['status'] );
	}

	public static function get_clinics() {
		return self::to_response( Clinic_Booking_Api_Client::get( '/v1/clinics' ) );
	}

	public static function get_doctors( $request ) {
		$clinic_id = sanitize_text_field( $request->get_param( 'clinicId' ) );
		$query     = $clinic_id ? array( 'clinicId' => $clinic_id ) : array();
		return self::to_response( Clinic_Booking_Api_Client::get( '/v1/doctors', $query ) );
	}

	public static function get_services( $request ) {
		$clinic_id = sanitize_text_field( $request->get_param( 'clinicId' ) );
		$query     = $clinic_id ? array( 'clinicId' => $clinic_id ) : array();
		return self::to_response( Clinic_Booking_Api_Client::get( '/v1/services', $query ) );
	}

	public static function get_available_doctors( $request ) {
		$query = array(
			'clinicId' => sanitize_text_field( $request->get_param( 'clinicId' ) ),
			'from'     => sanitize_text_field( $request->get_param( 'from' ) ),
			'to'       => sanitize_text_field( $request->get_param( 'to' ) ),
		);
		return self::to_response( Clinic_Booking_Api_Client::get( '/v1/available-doctors', $query ) );
	}

	public static function get_availability( $request ) {
		$query = array(
			'doctorId'  => sanitize_text_field( $request->get_param( 'doctorId' ) ),
			'serviceId' => sanitize_text_field( $request->get_param( 'serviceId' ) ),
			'from'      => sanitize_text_field( $request->get_param( 'from' ) ),
			'to'        => sanitize_text_field( $request->get_param( 'to' ) ),
		);
		return self::to_response( Clinic_Booking_Api_Client::get( '/v1/availability', $query ) );
	}

	public static function post_hold( $request ) {
		$params = $request->get_json_params();

		$idempotency_key = self::require_idempotency_key( $params );
		if ( is_wp_error( $idempotency_key ) ) {
			return $idempotency_key;
		}

		$body = array(
			'clinicId'  => sanitize_text_field( $params['clinicId'] ?? '' ),
			'doctorId'  => sanitize_text_field( $params['doctorId'] ?? '' ),
			'serviceId' => sanitize_text_field( $params['serviceId'] ?? '' ),
			'startAt'   => sanitize_text_field( $params['startAt'] ?? '' ),
			'patient'   => array(
				'phone'    => sanitize_text_field( $params['patient']['phone'] ?? '' ),
				'fullName' => sanitize_text_field( $params['patient']['fullName'] ?? '' ),
			),
		);
		if ( ! empty( $params['patient']['email'] ) ) {
			$body['patient']['email'] = sanitize_email( $params['patient']['email'] );
		}

		return self::to_response( Clinic_Booking_Api_Client::post( '/v1/appointments/hold', $body, $idempotency_key ) );
	}

	public static function post_confirm( $request ) {
		$params = $request->get_json_params();
		return self::proxy_appointment_action( $params, 'confirm', array() );
	}

	public static function post_cancel( $request ) {
		$params = $request->get_json_params();
		$body   = array();
		if ( ! empty( $params['reason'] ) ) {
			$body['reason'] = sanitize_text_field( $params['reason'] );
		}
		return self::proxy_appointment_action( $params, 'cancel', $body );
	}

	private static function proxy_appointment_action( $params, $action, $body ) {
		$idempotency_key = self::require_idempotency_key( $params );
		if ( is_wp_error( $idempotency_key ) ) {
			return $idempotency_key;
		}
		$appointment_id = sanitize_text_field( $params['appointmentId'] ?? '' );
		if ( '' === $appointment_id ) {
			return new WP_Error( 'clinic_booking_missing_appointment_id', __( 'appointmentId is required.', 'clinic-booking-widget' ), array( 'status' => 400 ) );
		}
		return self::to_response(
			Clinic_Booking_Api_Client::post( '/v1/appointments/' . rawurlencode( $appointment_id ) . '/' . $action, $body, $idempotency_key )
		);
	}

	private static function require_idempotency_key( $params ) {
		$key = isset( $params['idempotencyKey'] ) ? sanitize_text_field( $params['idempotencyKey'] ) : '';
		if ( strlen( $key ) < 8 ) {
			return new WP_Error( 'clinic_booking_missing_idempotency_key', __( 'idempotencyKey is required.', 'clinic-booking-widget' ), array( 'status' => 400 ) );
		}
		return $key;
	}
}
