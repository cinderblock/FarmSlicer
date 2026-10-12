//! TLS for talking to Bambu Lab printers on the LAN (MQTT on 8883, FTPS on 990).
//!
//! A printer presents a certificate chained to Bambu's own CA and issued for
//! its serial number, while we reach it by IP address: nothing a public trust
//! store can vouch for. We accept the certificate but still check the
//! handshake signatures, so the server has to hold the certificate's key.

use std::sync::{Arc, OnceLock};

use tokio_rustls::rustls::client::Resumption;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::crypto::{
    CryptoProvider, verify_tls12_signature, verify_tls13_signature,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{self, ClientConfig, DigitallySignedStruct, SignatureScheme};

#[derive(Debug)]
struct AcceptPrinterCert(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptPrinterCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn build() -> ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports TLS 1.2 and 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptPrinterCert(provider)))
        .with_no_client_auth()
}

/// Client config for MQTT connections, shared by every printer.
pub fn mqtt_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG.get_or_init(|| Arc::new(build())).clone()
}

/// Client config for one FTPS session, with a session cache of its own.
///
/// The printer's FTP server only accepts a data connection that resumes the
/// control connection's TLS session. rustls resumes automatically when both
/// connections use the same config and server name; a private cache makes
/// sure the session on offer is that control connection's, not one left by
/// an MQTT reconnect or another upload to the same address.
pub fn ftps_config() -> Arc<ClientConfig> {
    let mut config = build();
    config.resumption = Resumption::in_memory_sessions(4);
    Arc::new(config)
}
