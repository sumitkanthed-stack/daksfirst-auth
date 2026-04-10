/**
 * DocuSign Webhook Handler
 * Receives Connect notifications when Termsheet / Facility Letter envelopes
 * are completed, declined, or voided.
 *
 * NOT LIVE — uncomment in server.js when ready to activate.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logAudit } = require('../services/audit');
const { downloadSignedDocument } = require('../services/docusign');
const { getGraphToken, uploadFileToOneDrive } = require('../services/graph');
const { notifyDealEvent } = require('../services/notifications');

/**
 * POST /api/docusign/webhook
 * DocuSign Connect sends JSON here (configured via eventNotification in the envelope)
 */
router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
  try {
    const body = req.body;

    // Extract envelope ID — DocuSign Connect v2 vs legacy payload format
    const envelopeId = body.envelopeId
      || (body.data && body.data.envelopeId)
      || (body.data && body.data.envelopeSummary && body.data.envelopeSummary.envelopeId);

    const event = body.event || body.status
      || (body.data && body.data.envelopeSummary && body.data.envelopeSummary.status);

    if (!envelopeId) {
      console.warn('[docusign-webhook] No envelopeId in payload');
      return res.status(200).json({ received: true });
    }

    console.log('[docusign-webhook] Received:', envelopeId, 'event:', event);

    // Extract custom fields to determine docType (termsheet vs facility_letter)
    const customFields = body.data?.envelopeSummary?.customFields?.textCustomFields
      || body.customFields?.textCustomFields || [];
    const docTypeField = customFields.find(f => f.name === 'docType');
    const dealRefField = customFields.find(f => f.name === 'dealRef');
    const docType = docTypeField?.value || 'termsheet'; // default to termsheet

    // Find the deal — look up by envelope ID in the appropriate column
    const envelopeCol = docType === 'facility_letter' ? 'fl_docusign_envelope_id' : 'ts_docusign_envelope_id';
    const dealResult = await pool.query(
      `SELECT id, submission_id, status, deal_stage, borrower_name, user_id
       FROM deal_submissions WHERE ${envelopeCol} = $1`,
      [envelopeId]
    );

    if (dealResult.rows.length === 0) {
      // Fallback: try dealRef from custom fields
      if (dealRefField?.value) {
        const fallbackResult = await pool.query(
          `SELECT id, submission_id, status, deal_stage, borrower_name, user_id
           FROM deal_submissions WHERE submission_id = $1`,
          [dealRefField.value]
        );
        if (fallbackResult.rows.length === 0) {
          console.warn('[docusign-webhook] No deal found for envelope:', envelopeId);
          return res.status(200).json({ received: true });
        }
        dealResult.rows = fallbackResult.rows;
      } else {
        console.warn('[docusign-webhook] No deal found for envelope:', envelopeId);
        return res.status(200).json({ received: true });
      }
    }

    const deal = dealResult.rows[0];
    const isCompleted = event === 'envelope-completed' || event === 'completed';
    const isDeclined = event === 'envelope-declined' || event === 'declined';
    const isVoided = event === 'envelope-voided' || event === 'voided';

    // ── TERMSHEET ──────────────────────────────────────────────
    if (docType === 'termsheet') {
      if (isCompleted) {
        console.log('[docusign-webhook] TERMSHEET SIGNED for deal:', deal.submission_id);

        // Download signed PDF and upload to OneDrive
        let signedPdfUrl = null;
        try {
          const signedBuffer = await downloadSignedDocument(envelopeId);
          const graphToken = await getGraphToken();
          const uploadResult = await uploadFileToOneDrive(
            graphToken, deal.submission_id,
            `Termsheet_Signed_${deal.submission_id}.pdf`,
            signedBuffer
          );
          signedPdfUrl = uploadResult.downloadUrl;
          console.log('[docusign-webhook] Signed termsheet uploaded:', signedPdfUrl);
        } catch (uploadErr) {
          console.error('[docusign-webhook] Signed termsheet upload failed:', uploadErr.message);
        }

        await pool.query(
          `UPDATE deal_submissions SET
            ts_signed = true,
            ts_signed_at = NOW(),
            ts_signed_pdf_url = $1,
            ts_docusign_status = 'completed',
            updated_at = NOW()
           WHERE id = $2`,
          [signedPdfUrl, deal.id]
        );

        await logAudit(deal.id, 'termsheet_signed', deal.status, deal.status, {
          envelope_id: envelopeId, signed_pdf_url: signedPdfUrl, doc_type: 'termsheet'
        }, null);

        // Notify internal team
        await notifyDealEvent('termsheet_signed', { submission_id: deal.submission_id }, []);

      } else if (isDeclined) {
        console.log('[docusign-webhook] TERMSHEET DECLINED for deal:', deal.submission_id);
        await pool.query(
          `UPDATE deal_submissions SET ts_docusign_status = 'declined', updated_at = NOW() WHERE id = $1`,
          [deal.id]
        );
        await logAudit(deal.id, 'termsheet_declined', deal.status, deal.status, {
          envelope_id: envelopeId, doc_type: 'termsheet'
        }, null);

      } else if (isVoided) {
        console.log('[docusign-webhook] TERMSHEET VOIDED for deal:', deal.submission_id);
        await pool.query(
          `UPDATE deal_submissions SET ts_docusign_status = 'voided', updated_at = NOW() WHERE id = $1`,
          [deal.id]
        );
        await logAudit(deal.id, 'termsheet_voided', deal.status, deal.status, {
          envelope_id: envelopeId, doc_type: 'termsheet'
        }, null);
      }
    }

    // ── FACILITY LETTER ────────────────────────────────────────
    if (docType === 'facility_letter') {
      if (isCompleted) {
        console.log('[docusign-webhook] FACILITY LETTER SIGNED for deal:', deal.submission_id);

        let signedPdfUrl = null;
        try {
          const signedBuffer = await downloadSignedDocument(envelopeId);
          const graphToken = await getGraphToken();
          const uploadResult = await uploadFileToOneDrive(
            graphToken, deal.submission_id,
            `FacilityLetter_Signed_${deal.submission_id}.pdf`,
            signedBuffer
          );
          signedPdfUrl = uploadResult.downloadUrl;
          console.log('[docusign-webhook] Signed facility letter uploaded:', signedPdfUrl);
        } catch (uploadErr) {
          console.error('[docusign-webhook] Signed facility letter upload failed:', uploadErr.message);
        }

        await pool.query(
          `UPDATE deal_submissions SET
            fl_signed = true,
            fl_signed_at = NOW(),
            fl_signed_pdf_url = $1,
            fl_docusign_status = 'completed',
            updated_at = NOW()
           WHERE id = $2`,
          [signedPdfUrl, deal.id]
        );

        await logAudit(deal.id, 'facility_letter_signed', deal.status, deal.status, {
          envelope_id: envelopeId, signed_pdf_url: signedPdfUrl, doc_type: 'facility_letter'
        }, null);

        await notifyDealEvent('facility_letter_signed', { submission_id: deal.submission_id }, []);

      } else if (isDeclined) {
        console.log('[docusign-webhook] FACILITY LETTER DECLINED for deal:', deal.submission_id);
        await pool.query(
          `UPDATE deal_submissions SET fl_docusign_status = 'declined', updated_at = NOW() WHERE id = $1`,
          [deal.id]
        );
        await logAudit(deal.id, 'facility_letter_declined', deal.status, deal.status, {
          envelope_id: envelopeId, doc_type: 'facility_letter'
        }, null);

      } else if (isVoided) {
        console.log('[docusign-webhook] FACILITY LETTER VOIDED for deal:', deal.submission_id);
        await pool.query(
          `UPDATE deal_submissions SET fl_docusign_status = 'voided', updated_at = NOW() WHERE id = $1`,
          [deal.id]
        );
        await logAudit(deal.id, 'facility_letter_voided', deal.status, deal.status, {
          envelope_id: envelopeId, doc_type: 'facility_letter'
        }, null);
      }
    }

    res.status(200).json({ received: true, processed: true });
  } catch (error) {
    console.error('[docusign-webhook] Error:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

/**
 * GET /api/docusign/status/:envelopeId
 * Manual status check (for internal debugging)
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
