/**
 * DocuSign Webhook Handler
 * Receives Connect notifications when envelopes are completed/declined
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logAudit } = require('../services/audit');
const { downloadSignedDocument } = require('../services/docusign');
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');

/**
 * POST /api/docusign/webhook
 * DocuSign Connect sends XML or JSON payloads here
 * We configured JSON in our envelope's eventNotification
 */
router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
  try {
    const body = req.body;

    // DocuSign sends the envelope status in the payload
    const envelopeId = body.envelopeId || (body.data && body.data.envelopeId);
    const status = body.event || body.status || (body.data && body.data.envelopeSummary && body.data.envelopeSummary.status);

    if (!envelopeId) {
      console.warn('[docusign-webhook] No envelopeId in payload');
      return res.status(200).json({ received: true }); // Always 200 to prevent retries
    }

    console.log('[docusign-webhook] Received:', envelopeId, 'event:', status);

    // Find the deal by envelope ID
    const dealResult = await pool.query(
      `SELECT id, submission_id, status, borrower_name FROM deal_submissions WHERE docusign_envelope_id = $1`,
      [envelopeId]
    );

    if (dealResult.rows.length === 0) {
      console.warn('[docusign-webhook] No deal found for envelope:', envelopeId);
      return res.status(200).json({ received: true });
    }

    const deal = dealResult.rows[0];

    // Handle based on event type
    if (status === 'envelope-completed' || status === 'completed') {
      // DIP has been signed!
      console.log('[docusign-webhook] DIP SIGNED for deal:', deal.submission_id);

      // Download the signed PDF from DocuSign
      let signedPdfUrl = null;
      try {
        const signedBuffer = await downloadSignedDocument(envelopeId);

        // Upload signed PDF to OneDrive
        const graphToken = await getGraphToken();
        const uploadResult = await uploadFileToOneDrive(
          graphToken,
          deal.submission_id,
          `DIP_Signed_${deal.submission_id}.pdf`,
          signedBuffer
        );
        signedPdfUrl = uploadResult.downloadUrl;
        console.log('[docusign-webhook] Signed PDF uploaded to OneDrive:', signedPdfUrl);
      } catch (uploadErr) {
        console.error('[docusign-webhook] Failed to download/upload signed PDF:', uploadErr.message);
        // Don't fail the webhook — still update the deal status
      }

      // Update deal status
      await pool.query(
        `UPDATE deal_submissions SET
          dip_signed = true,
          dip_signed_at = NOW(),
          dip_signed_pdf_url = $1,
          docusign_status = 'completed',
          updated_at = NOW()
         WHERE id = $2`,
        [signedPdfUrl, deal.id]
      );

      await logAudit(deal.id, 'dip_signed', 'dip_issued', 'dip_signed',
        { envelope_id: envelopeId, signed_pdf_url: signedPdfUrl }, null);

    } else if (status === 'envelope-declined' || status === 'declined') {
      console.log('[docusign-webhook] DIP DECLINED for deal:', deal.submission_id);

      await pool.query(
        `UPDATE deal_submissions SET
          docusign_status = 'declined',
          updated_at = NOW()
         WHERE id = $1`,
        [deal.id]
      );

      await logAudit(deal.id, 'dip_declined', 'dip_issued', 'dip_declined',
        { envelope_id: envelopeId }, null);

    } else if (status === 'envelope-voided' || status === 'voided') {
      console.log('[docusign-webhook] DIP VOIDED for deal:', deal.submission_id);

      await pool.query(
        `UPDATE deal_submissions SET
          docusign_status = 'voided',
          updated_at = NOW()
         WHERE id = $1`,
        [deal.id]
      );

      await logAudit(deal.id, 'dip_voided', 'dip_issued', 'dip_voided',
        { envelope_id: envelopeId }, null);
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ received: true, processed: true });
  } catch (error) {
    console.error('[docusign-webhook] Error:', error);
    // Still return 200 to prevent DocuSign retrying
    res.status(200).json({ received: true, error: error.message });
  }
});

/**
 * GET /api/docusign/status/:envelopeId
 * Manual status check (for internal use / debugging)
 */
router.get('/status/:envelopeId', async (req, res) => {
  try {
    const { getEnvelopeStatus } = require('../services/docusign');
    const status = await getEnvelopeStatus(req.params.envelopeId);
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
