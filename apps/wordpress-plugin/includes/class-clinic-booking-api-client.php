<?php
/**
 * Thin HTTP client for the booking API - attaches the tenant API key
 * server-side (via wp_remote_request, never in a browser-facing response)
 * and returns a decoded body + status. Contains no booking logic of its
 * own: every call is a direct pass-through to one documented endpoint
 * (docs/API.md §4), and the caller (class-clinic-booking-rest-proxy.php)
 * decides what to do with the result.
 *
 * @package ClinicBookingWidget
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Clinic_Booking_Api_Client {

	/**
	 * @return array{status:int, body:mixed, error:?string}
	 */
	public static function request( $method, $path, $query = array(), $body = null, $idempotency_key = null ) {
		$base_url = Clinic_Booking_Settings::get_api_base_url();
		$api_key  = Clinic_Booking_Settings::get_api_key();

		if ( '' === $base_url || '' === $api_key ) {
			return array(
				'status' => 500,
				'body'   => null,
				'error'  => __( 'The booking widget is not configured yet. An administrator needs to set the API URL and key under Settings → Clinic Booking.', 'clinic-booking-widget' ),
			);
		}

		$url = $base_url . $path;
		if ( ! empty( $query ) ) {
			$url = add_query_arg( $query, $url );
		}

		$headers = array(
			'Authorization' => 'Bearer ' . $api_key,
			'Content-Type'  => 'application/json',
			'Accept'        => 'application/json',
		);
		if ( $idempotency_key ) {
			$headers['Idempotency-Key'] = $idempotency_key;
		}

		$args = array(
			'method'  => $method,
			'headers' => $headers,
			'timeout' => 15,
		);
		if ( null !== $body ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			return array(
				'status' => 502,
				'body'   => null,
				'error'  => $response->get_error_message(),
			);
		}

		$status        = wp_remote_retrieve_response_code( $response );
		$raw_body      = wp_remote_retrieve_body( $response );
		$decoded_body  = '' !== $raw_body ? json_decode( $raw_body, true ) : null;

		return array(
			'status' => $status,
			'body'   => $decoded_body,
			'error'  => null,
		);
	}

	public static function get( $path, $query = array() ) {
		return self::request( 'GET', $path, $query );
	}

	public static function post( $path, $body, $idempotency_key ) {
		return self::request( 'POST', $path, array(), $body, $idempotency_key );
	}
}
