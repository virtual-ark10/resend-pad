// Event rules — the backbone that turns a fired event into the next action.
//
// One table, shared by the pad and the leads engine because they run one store:
// whoever fires the event, the same rule moves the lead. Every rule gets
// ({ event, payload, store }) and may write, advance a stage or add a note; the
// store marks the event processed afterwards (store.processEvents).
//
// Brand-agnostic: stage keys come from the store (config.json -> leads.stages),
// nothing here knows a product name.

'use strict';

function buildRules(store) {
  const advance = (leadId, why) => {
    const lead = store.get('SELECT id, stage FROM leads WHERE id = ?', leadId);
    if (!lead) return null;
    const next = store.advanceStage(lead.stage);
    if (!next || next === lead.stage) return null;
    store.setStage(leadId, next, { by: 'rule', note: why });
    return { lead_id: leadId, from: lead.stage, to: next, why };
  };

  return {
    // A new lead exists (discovery, form, manual add): make sure it sits in the
    // first stage and leave a marker so the timeline starts with an entry.
    'lead.created': ({ payload }) => {
      if (!payload.leadId) return null;
      const lead = store.get('SELECT id, stage FROM leads WHERE id = ?', payload.leadId);
      if (lead && !store.stageOrder.includes(lead.stage)) {
        store.setStage(payload.leadId, store.firstStage, { by: 'rule', note: 'not a known stage' });
      }
      return { lead_id: payload.leadId, note: 'lead in the pipeline' };
    },

    // A draft was composed for a lead: nothing moves yet, but the lead's timeline
    // shows the work in progress (and the CRM can surface "draft sitting ready").
    'draft.created': ({ payload }) => {
      if (!payload.leadId) return null;
      store.note(payload.leadId, `draft composed${payload.subject ? ': ' + payload.subject : ''}`, { source: 'pad' });
      return { lead_id: payload.leadId, note: 'draft composed' };
    },

    // The send is what moves a lead along the sequence.
    'email.sent': ({ payload }) => {
      if (!payload.leadId) return null;
      const when = payload.first ? 'first email sent' : 'follow-up sent';
      return advance(payload.leadId, when);
    },

    // An inbound reply trumps the cadence: the lead jumps to the reply stage.
    'reply.received': ({ payload }) => {
      if (!payload.leadId) return null;
      const lead = store.get('SELECT id, stage FROM leads WHERE id = ?', payload.leadId);
      if (!lead) return null;
      if (store.isTerminal(lead.stage) && lead.stage !== store.wonStageKey) {
        return { lead_id: payload.leadId, note: `reply arrived while in ${lead.stage}` };
      }
      const target = store.replyStageKey;
      if (lead.stage === target) {
        store.note(payload.leadId, 'another reply received', { source: 'pad' });
        return { lead_id: payload.leadId, note: 'follow-up reply' };
      }
      store.setStage(payload.leadId, target, { by: 'rule', note: 'inbound reply' });
      return { lead_id: payload.leadId, from: lead.stage, to: target, why: 'reply received' };
    },

    // Redraft feedback: keep it, count it, and hand it to whoever writes drafts
    // (GET /api/redraft-guidance) instead of silently dropping the draft.
    'draft.redraft_requested': ({ payload }) => {
      if (!payload.leadId) return null;
      return { lead_id: payload.leadId, note: `redraft: ${payload.reason || 'no reason given'}` };
    },

    'draft.discarded': ({ payload }) => {
      if (!payload.leadId) return null;
      store.note(payload.leadId, 'draft discarded without sending', { source: 'pad' });
      return { lead_id: payload.leadId, note: 'draft discarded' };
    },
  };
}

module.exports = { buildRules };
