/** the ext-sodium API as PHP 8.5.7 reports it; `bun run gen:sodium-api` writes it */
export const SODIUM_API = {
	version: '8.5.7',
	functions: [
		{
			name: 'sodium_crypto_aead_aes256gcm_is_available',
			params: [],
			returns: 'bool'
		},
		{
			name: 'sodium_crypto_aead_aes256gcm_decrypt',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_aead_aes256gcm_encrypt',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_aes256gcm_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_aegis128l_decrypt',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_aead_aegis128l_encrypt',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_aegis128l_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_aegis256_decrypt',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_aead_aegis256_encrypt',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_aegis256_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_chacha20poly1305_decrypt',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_aead_chacha20poly1305_encrypt',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_chacha20poly1305_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_chacha20poly1305_ietf_decrypt',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_aead_chacha20poly1305_ietf_encrypt',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_chacha20poly1305_ietf_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_xchacha20poly1305_ietf_decrypt',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_aead_xchacha20poly1305_ietf_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_aead_xchacha20poly1305_ietf_encrypt',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'additional_data',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_auth',
			params: [
				{
					name: 'message',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_auth_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_auth_verify',
			params: [
				{
					name: 'mac',
					type: 'string'
				},
				{
					name: 'message',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'bool'
		},
		{
			name: 'sodium_crypto_box',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_box_keypair',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_box_seed_keypair',
			params: [
				{
					name: 'seed',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_box_keypair_from_secretkey_and_publickey',
			params: [
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				},
				{
					name: 'public_key',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_box_open',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_box_publickey',
			params: [
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_box_publickey_from_secretkey',
			params: [
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_box_seal',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'public_key',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_box_seal_open',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_box_secretkey',
			params: [
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_add',
			params: [
				{
					name: 'p',
					type: 'string'
				},
				{
					name: 'q',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_from_hash',
			params: [
				{
					name: 's',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_is_valid_point',
			params: [
				{
					name: 's',
					type: 'string'
				}
			],
			returns: 'bool'
		},
		{
			name: 'sodium_crypto_core_ristretto255_random',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_add',
			params: [
				{
					name: 'x',
					type: 'string'
				},
				{
					name: 'y',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_complement',
			params: [
				{
					name: 's',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_invert',
			params: [
				{
					name: 's',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_mul',
			params: [
				{
					name: 'x',
					type: 'string'
				},
				{
					name: 'y',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_negate',
			params: [
				{
					name: 's',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_random',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_reduce',
			params: [
				{
					name: 's',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_scalar_sub',
			params: [
				{
					name: 'x',
					type: 'string'
				},
				{
					name: 'y',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_core_ristretto255_sub',
			params: [
				{
					name: 'p',
					type: 'string'
				},
				{
					name: 'q',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_kx_keypair',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_kx_publickey',
			params: [
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_kx_secretkey',
			params: [
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_kx_seed_keypair',
			params: [
				{
					name: 'seed',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_kx_client_session_keys',
			params: [
				{
					name: 'client_key_pair',
					type: 'string',
					sensitive: true
				},
				{
					name: 'server_key',
					type: 'string'
				}
			],
			returns: 'array'
		},
		{
			name: 'sodium_crypto_kx_server_session_keys',
			params: [
				{
					name: 'server_key_pair',
					type: 'string',
					sensitive: true
				},
				{
					name: 'client_key',
					type: 'string'
				}
			],
			returns: 'array'
		},
		{
			name: 'sodium_crypto_generichash',
			params: [
				{
					name: 'message',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true,
					def: ''
				},
				{
					name: 'length',
					type: 'int',
					def: 32
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_generichash_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_generichash_init',
			params: [
				{
					name: 'key',
					type: 'string',
					sensitive: true,
					def: ''
				},
				{
					name: 'length',
					type: 'int',
					def: 32
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_generichash_update',
			params: [
				{
					name: 'state',
					type: 'string',
					ref: true
				},
				{
					name: 'message',
					type: 'string'
				}
			],
			returns: 'true'
		},
		{
			name: 'sodium_crypto_generichash_final',
			params: [
				{
					name: 'state',
					type: 'string',
					ref: true
				},
				{
					name: 'length',
					type: 'int',
					def: 32
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_kdf_derive_from_key',
			params: [
				{
					name: 'subkey_length',
					type: 'int'
				},
				{
					name: 'subkey_id',
					type: 'int'
				},
				{
					name: 'context',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_kdf_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_pwhash',
			params: [
				{
					name: 'length',
					type: 'int'
				},
				{
					name: 'password',
					type: 'string',
					sensitive: true
				},
				{
					name: 'salt',
					type: 'string'
				},
				{
					name: 'opslimit',
					type: 'int'
				},
				{
					name: 'memlimit',
					type: 'int'
				},
				{
					name: 'algo',
					type: 'int',
					def: 2
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_pwhash_str',
			params: [
				{
					name: 'password',
					type: 'string',
					sensitive: true
				},
				{
					name: 'opslimit',
					type: 'int'
				},
				{
					name: 'memlimit',
					type: 'int'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_pwhash_str_verify',
			params: [
				{
					name: 'hash',
					type: 'string'
				},
				{
					name: 'password',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'bool'
		},
		{
			name: 'sodium_crypto_pwhash_str_needs_rehash',
			params: [
				{
					name: 'password',
					type: 'string'
				},
				{
					name: 'opslimit',
					type: 'int'
				},
				{
					name: 'memlimit',
					type: 'int'
				}
			],
			returns: 'bool'
		},
		{
			name: 'sodium_crypto_pwhash_scryptsalsa208sha256',
			params: [
				{
					name: 'length',
					type: 'int'
				},
				{
					name: 'password',
					type: 'string',
					sensitive: true
				},
				{
					name: 'salt',
					type: 'string'
				},
				{
					name: 'opslimit',
					type: 'int'
				},
				{
					name: 'memlimit',
					type: 'int'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_pwhash_scryptsalsa208sha256_str',
			params: [
				{
					name: 'password',
					type: 'string',
					sensitive: true
				},
				{
					name: 'opslimit',
					type: 'int'
				},
				{
					name: 'memlimit',
					type: 'int'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_pwhash_scryptsalsa208sha256_str_verify',
			params: [
				{
					name: 'hash',
					type: 'string'
				},
				{
					name: 'password',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'bool'
		},
		{
			name: 'sodium_crypto_scalarmult',
			params: [
				{
					name: 'n',
					type: 'string'
				},
				{
					name: 'p',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_scalarmult_ristretto255',
			params: [
				{
					name: 'n',
					type: 'string'
				},
				{
					name: 'p',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_scalarmult_ristretto255_base',
			params: [
				{
					name: 'n',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_secretbox',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_secretbox_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_secretbox_open',
			params: [
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_secretstream_xchacha20poly1305_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_secretstream_xchacha20poly1305_init_push',
			params: [
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'array'
		},
		{
			name: 'sodium_crypto_secretstream_xchacha20poly1305_push',
			params: [
				{
					name: 'state',
					type: 'string',
					ref: true
				},
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'additional_data',
					type: 'string',
					def: ''
				},
				{
					name: 'tag',
					type: 'int',
					def: 0
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_secretstream_xchacha20poly1305_init_pull',
			params: [
				{
					name: 'header',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_secretstream_xchacha20poly1305_pull',
			params: [
				{
					name: 'state',
					type: 'string',
					ref: true
				},
				{
					name: 'ciphertext',
					type: 'string'
				},
				{
					name: 'additional_data',
					type: 'string',
					def: ''
				}
			],
			returns: 'array|false'
		},
		{
			name: 'sodium_crypto_secretstream_xchacha20poly1305_rekey',
			params: [
				{
					name: 'state',
					type: 'string',
					ref: true
				}
			],
			returns: 'void'
		},
		{
			name: 'sodium_crypto_shorthash',
			params: [
				{
					name: 'message',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_shorthash_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign',
			params: [
				{
					name: 'message',
					type: 'string'
				},
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_detached',
			params: [
				{
					name: 'message',
					type: 'string'
				},
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_ed25519_pk_to_curve25519',
			params: [
				{
					name: 'public_key',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_ed25519_sk_to_curve25519',
			params: [
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_keypair',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_keypair_from_secretkey_and_publickey',
			params: [
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				},
				{
					name: 'public_key',
					type: 'string'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_open',
			params: [
				{
					name: 'signed_message',
					type: 'string'
				},
				{
					name: 'public_key',
					type: 'string'
				}
			],
			returns: 'string|false'
		},
		{
			name: 'sodium_crypto_sign_publickey',
			params: [
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_secretkey',
			params: [
				{
					name: 'key_pair',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_publickey_from_secretkey',
			params: [
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_seed_keypair',
			params: [
				{
					name: 'seed',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_sign_verify_detached',
			params: [
				{
					name: 'signature',
					type: 'string'
				},
				{
					name: 'message',
					type: 'string'
				},
				{
					name: 'public_key',
					type: 'string'
				}
			],
			returns: 'bool'
		},
		{
			name: 'sodium_crypto_stream',
			params: [
				{
					name: 'length',
					type: 'int'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_stream_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_stream_xor',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_stream_xchacha20',
			params: [
				{
					name: 'length',
					type: 'int'
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_stream_xchacha20_keygen',
			params: [],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_stream_xchacha20_xor',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_stream_xchacha20_xor_ic',
			params: [
				{
					name: 'message',
					type: 'string',
					sensitive: true
				},
				{
					name: 'nonce',
					type: 'string'
				},
				{
					name: 'counter',
					type: 'int'
				},
				{
					name: 'key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_add',
			params: [
				{
					name: 'string1',
					type: 'string',
					ref: true
				},
				{
					name: 'string2',
					type: 'string'
				}
			],
			returns: 'void'
		},
		{
			name: 'sodium_compare',
			params: [
				{
					name: 'string1',
					type: 'string',
					sensitive: true
				},
				{
					name: 'string2',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'int'
		},
		{
			name: 'sodium_increment',
			params: [
				{
					name: 'string',
					type: 'string',
					ref: true
				}
			],
			returns: 'void'
		},
		{
			name: 'sodium_memcmp',
			params: [
				{
					name: 'string1',
					type: 'string',
					sensitive: true
				},
				{
					name: 'string2',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'int'
		},
		{
			name: 'sodium_memzero',
			params: [
				{
					name: 'string',
					type: 'string',
					ref: true,
					sensitive: true
				}
			],
			returns: 'void'
		},
		{
			name: 'sodium_pad',
			params: [
				{
					name: 'string',
					type: 'string',
					sensitive: true
				},
				{
					name: 'block_size',
					type: 'int'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_unpad',
			params: [
				{
					name: 'string',
					type: 'string',
					sensitive: true
				},
				{
					name: 'block_size',
					type: 'int'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_bin2hex',
			params: [
				{
					name: 'string',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_hex2bin',
			params: [
				{
					name: 'string',
					type: 'string',
					sensitive: true
				},
				{
					name: 'ignore',
					type: 'string',
					def: ''
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_bin2base64',
			params: [
				{
					name: 'string',
					type: 'string',
					sensitive: true
				},
				{
					name: 'id',
					type: 'int'
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_base642bin',
			params: [
				{
					name: 'string',
					type: 'string',
					sensitive: true
				},
				{
					name: 'id',
					type: 'int'
				},
				{
					name: 'ignore',
					type: 'string',
					def: ''
				}
			],
			returns: 'string'
		},
		{
			name: 'sodium_crypto_scalarmult_base',
			params: [
				{
					name: 'secret_key',
					type: 'string',
					sensitive: true
				}
			],
			returns: 'string'
		}
	],
	constants: {
		SODIUM_LIBRARY_VERSION: '1.0.22',
		SODIUM_LIBRARY_MAJOR_VERSION: 26,
		SODIUM_LIBRARY_MINOR_VERSION: 4,
		SODIUM_CRYPTO_AEAD_AES256GCM_KEYBYTES: 32,
		SODIUM_CRYPTO_AEAD_AES256GCM_NSECBYTES: 0,
		SODIUM_CRYPTO_AEAD_AES256GCM_NPUBBYTES: 12,
		SODIUM_CRYPTO_AEAD_AES256GCM_ABYTES: 16,
		SODIUM_CRYPTO_AEAD_AEGIS128L_KEYBYTES: 16,
		SODIUM_CRYPTO_AEAD_AEGIS128L_NSECBYTES: 0,
		SODIUM_CRYPTO_AEAD_AEGIS128L_NPUBBYTES: 16,
		SODIUM_CRYPTO_AEAD_AEGIS128L_ABYTES: 32,
		SODIUM_CRYPTO_AEAD_AEGIS256_KEYBYTES: 32,
		SODIUM_CRYPTO_AEAD_AEGIS256_NSECBYTES: 0,
		SODIUM_CRYPTO_AEAD_AEGIS256_NPUBBYTES: 32,
		SODIUM_CRYPTO_AEAD_AEGIS256_ABYTES: 32,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_KEYBYTES: 32,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_NSECBYTES: 0,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_NPUBBYTES: 8,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_ABYTES: 16,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_IETF_KEYBYTES: 32,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_IETF_NSECBYTES: 0,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_IETF_NPUBBYTES: 12,
		SODIUM_CRYPTO_AEAD_CHACHA20POLY1305_IETF_ABYTES: 16,
		SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES: 32,
		SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NSECBYTES: 0,
		SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES: 24,
		SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_ABYTES: 16,
		SODIUM_CRYPTO_AUTH_BYTES: 32,
		SODIUM_CRYPTO_AUTH_KEYBYTES: 32,
		SODIUM_CRYPTO_BOX_SEALBYTES: 48,
		SODIUM_CRYPTO_BOX_SECRETKEYBYTES: 32,
		SODIUM_CRYPTO_BOX_PUBLICKEYBYTES: 32,
		SODIUM_CRYPTO_BOX_KEYPAIRBYTES: 64,
		SODIUM_CRYPTO_BOX_MACBYTES: 16,
		SODIUM_CRYPTO_BOX_NONCEBYTES: 24,
		SODIUM_CRYPTO_BOX_SEEDBYTES: 32,
		SODIUM_CRYPTO_KDF_BYTES_MIN: 16,
		SODIUM_CRYPTO_KDF_BYTES_MAX: 64,
		SODIUM_CRYPTO_KDF_CONTEXTBYTES: 8,
		SODIUM_CRYPTO_KDF_KEYBYTES: 32,
		SODIUM_CRYPTO_KX_SEEDBYTES: 32,
		SODIUM_CRYPTO_KX_SESSIONKEYBYTES: 32,
		SODIUM_CRYPTO_KX_PUBLICKEYBYTES: 32,
		SODIUM_CRYPTO_KX_SECRETKEYBYTES: 32,
		SODIUM_CRYPTO_KX_KEYPAIRBYTES: 64,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_ABYTES: 17,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_HEADERBYTES: 24,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_KEYBYTES: 32,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_MESSAGEBYTES_MAX: 274877906816,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_MESSAGE: 0,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH: 1,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_REKEY: 2,
		SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL: 3,
		SODIUM_CRYPTO_GENERICHASH_BYTES: 32,
		SODIUM_CRYPTO_GENERICHASH_BYTES_MIN: 16,
		SODIUM_CRYPTO_GENERICHASH_BYTES_MAX: 64,
		SODIUM_CRYPTO_GENERICHASH_KEYBYTES: 32,
		SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MIN: 16,
		SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MAX: 64,
		SODIUM_CRYPTO_PWHASH_ALG_ARGON2I13: 1,
		SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13: 2,
		SODIUM_CRYPTO_PWHASH_ALG_DEFAULT: 2,
		SODIUM_CRYPTO_PWHASH_SALTBYTES: 16,
		SODIUM_CRYPTO_PWHASH_STRPREFIX: '$argon2id$',
		SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE: 2,
		SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE: 67108864,
		SODIUM_CRYPTO_PWHASH_OPSLIMIT_MODERATE: 3,
		SODIUM_CRYPTO_PWHASH_MEMLIMIT_MODERATE: 268435456,
		SODIUM_CRYPTO_PWHASH_OPSLIMIT_SENSITIVE: 4,
		SODIUM_CRYPTO_PWHASH_MEMLIMIT_SENSITIVE: 1073741824,
		SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_SALTBYTES: 32,
		SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_STRPREFIX: '$7$',
		SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_OPSLIMIT_INTERACTIVE: 524288,
		SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_MEMLIMIT_INTERACTIVE: 16777216,
		SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_OPSLIMIT_SENSITIVE: 33554432,
		SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_MEMLIMIT_SENSITIVE: 1073741824,
		SODIUM_CRYPTO_SCALARMULT_BYTES: 32,
		SODIUM_CRYPTO_SCALARMULT_SCALARBYTES: 32,
		SODIUM_CRYPTO_SHORTHASH_BYTES: 8,
		SODIUM_CRYPTO_SHORTHASH_KEYBYTES: 16,
		SODIUM_CRYPTO_SECRETBOX_KEYBYTES: 32,
		SODIUM_CRYPTO_SECRETBOX_MACBYTES: 16,
		SODIUM_CRYPTO_SECRETBOX_NONCEBYTES: 24,
		SODIUM_CRYPTO_SIGN_BYTES: 64,
		SODIUM_CRYPTO_SIGN_SEEDBYTES: 32,
		SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES: 32,
		SODIUM_CRYPTO_SIGN_SECRETKEYBYTES: 64,
		SODIUM_CRYPTO_SIGN_KEYPAIRBYTES: 96,
		SODIUM_CRYPTO_STREAM_NONCEBYTES: 24,
		SODIUM_CRYPTO_STREAM_KEYBYTES: 32,
		SODIUM_CRYPTO_STREAM_XCHACHA20_NONCEBYTES: 24,
		SODIUM_CRYPTO_STREAM_XCHACHA20_KEYBYTES: 32,
		SODIUM_BASE64_VARIANT_ORIGINAL: 1,
		SODIUM_BASE64_VARIANT_ORIGINAL_NO_PADDING: 3,
		SODIUM_BASE64_VARIANT_URLSAFE: 5,
		SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING: 7,
		SODIUM_CRYPTO_SCALARMULT_RISTRETTO255_BYTES: 32,
		SODIUM_CRYPTO_SCALARMULT_RISTRETTO255_SCALARBYTES: 32,
		SODIUM_CRYPTO_CORE_RISTRETTO255_BYTES: 32,
		SODIUM_CRYPTO_CORE_RISTRETTO255_HASHBYTES: 64,
		SODIUM_CRYPTO_CORE_RISTRETTO255_SCALARBYTES: 32,
		SODIUM_CRYPTO_CORE_RISTRETTO255_NONREDUCEDSCALARBYTES: 64
	},
	classes: ['SodiumException']
} as const;
