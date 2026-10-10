/**
 * The MCP surface of Hold On.
 *
 * `buildMcpServer` returns a fresh `McpServer` for one authenticated person.
 * Which tools exist depends on their role: an older adult's assistant gets the
 * ask / wait / pay tools, a trusted contact's assistant gets the inbox /
 * decide / policy tools. Neither can see or call the other's tools.
 */
import {
  McpServer,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { CLARIFYING_QUESTIONS, SIMULATED_NOTE } from '../domain/language.js';
import { formatUsd } from '../domain/text.js';
import {
  CONTACT_CHANNELS,
  PAYMENT_METHODS,
  type CheckInput,
  type ClarifyingField,
  type ContactChannel,
  type PaymentMethod,
  type Principal,
} from '../domain/types.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { HoldOnError, type HoldOnService } from '../service.js';
import { UI, registerCards, withCard } from './apps.js';
import { ICONS } from './icons.js';
import * as S from './schemas.js';

export const SERVER_NAME = 'holdon';
export const SERVER_VERSION = '0.1.0';

export interface McpBuildOptions {
  /** How often `holdon_wait_for_decision` reports progress. */
  progressIntervalMs?: number;
  /** Called for unexpected failures inside a tool. */
  onError?: (error: unknown, tool: string) => void;
}

const MEMBER_INSTRUCTIONS = `Hold On keeps money requests safe for an older adult. Call holdon_check_request before paying anyone, sending money, buying gift cards, or when the user says someone is demanding payment. Follow next_step from the result: place_hold, pay, or decline. Say the say_to_user text as given. Never repeat a phone number or link that came from the caller or message; only use contact details found under payee.official. Never tell the user they were foolish. ${SIMULATED_NOTE}`;

const CONTACT_INSTRUCTIONS = `Hold On lets a trusted family contact review money requests made by an older adult. Use holdon_family_inbox to see what is waiting, read the risk signals and their official sources aloud if asked, and use holdon_family_decide to approve or deny. A request that was stopped can only be denied. Do not call numbers or open links listed under untrusted_contact_details. ${SIMULATED_NOTE}`;

/** A successful result: the structured object for programs, plus a short text for the model. */
function ok(structured: object, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured as Record<string, unknown> };
}

function toolError(code: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error (${code}): ${message}` }], isError: true };
}

type Handler<A> = (args: A, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult> | CallToolResult | InputRequiredResult;

function supportsFormElicitation(server: McpServer): boolean {
  const elicitation = server.server.getClientCapabilities()?.elicitation;
  if (!elicitation) return false;
  // An empty object means form mode (the pre-2025-11-25 meaning); otherwise form must be declared.
  return Object.keys(elicitation).length === 0 || 'form' in elicitation;
}

function parseClarification(field: ClarifyingField, content: Record<string, unknown> | undefined): string | undefined {
  const value = content?.[field];
  if (typeof value !== 'string') return undefined;
  const allowed: readonly string[] = field === 'payment_method' ? PAYMENT_METHODS : CONTACT_CHANNELS;
  return allowed.includes(value) ? value : undefined;
}

export function buildMcpServer(service: HoldOnService, principal: Principal, options: McpBuildOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'Hold On',
      version: SERVER_VERSION,
      description: 'A money-safety check with family approval for voice assistants used by older adults. Payments are simulated.',
      icons: ICONS.check,
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: principal.role === 'member' ? MEMBER_INSTRUCTIONS : CONTACT_INSTRUCTIONS,
    },
  );

  /** Turn domain errors into tool execution errors the model can read and act on. */
  const guard = <A>(tool: string, handler: Handler<A>): Handler<A> => {
    return async (args, ctx) => {
      try {
        return await handler(args, ctx);
      } catch (error) {
        if (error instanceof HoldOnError) return toolError(error.code, error.message);
        options.onError?.(error, tool);
        return toolError('internal', 'Something went wrong inside Hold On. Nothing was paid and nothing was changed. Please try again.');
      }
    };
  };

  if (principal.role === 'member') registerMemberTools(server, service, principal, options, guard);
  else registerContactTools(server, service, principal, guard);
  registerCards(server, principal.role);
  return server;
}

type Guard = <A>(tool: string, handler: Handler<A>) => Handler<A>;

function registerMemberTools(server: McpServer, service: HoldOnService, principal: Principal, options: McpBuildOptions, guard: Guard): void {
  server.registerTool(
    'holdon_check_request',
    {
      title: 'Check a money request',
      description:
        'Check a request to pay someone, send money or buy gift cards before anything is paid. Compares the request with scam patterns published by official US sources and with a registry of official payee facts, then says whether to stop, ask the trusted family contact, or go ahead. Read-only: it saves a check record and moves no money. If one key detail is missing it may ask the user a single question.',
      inputSchema: S.CheckRequestInput,
      outputSchema: S.CheckRequestOutput,
      annotations: { title: 'Check a money request', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      icons: ICONS.check,
    },
    guard('holdon_check_request', async (args, ctx) => {
      let input: CheckInput = args;
      let clarification: { field: ClarifyingField; status: 'answered' | 'declined' | 'ask_user'; answer?: string; question?: string } | undefined;

      const field = service.clarifyingQuestion(principal, input);
      if (field) {
        const question = CLARIFYING_QUESTIONS[field];
        const response = inputResponse(ctx.mcpReq.inputResponses, 'clarify');
        if (response.kind === 'elicit') {
          const answer = response.action === 'accept' ? parseClarification(field, response.content) : undefined;
          if (answer) {
            input =
              field === 'payment_method'
                ? { ...input, payment_method: answer as PaymentMethod }
                : { ...input, contact_channel: answer as ContactChannel };
            clarification = { field, status: 'answered', answer };
          } else {
            clarification = { field, status: 'declined' };
          }
        } else if (supportsFormElicitation(server)) {
          // MCP form elicitation: one question, a fixed list of answers, nothing sensitive.
          return inputRequired({
            inputRequests: {
              clarify: inputRequired.elicit({
                message: question.message,
                requestedSchema: {
                  type: 'object',
                  properties: { [field]: { type: 'string', title: question.title, oneOf: [...question.options] } },
                  required: [field],
                },
              }),
            },
          });
        } else {
          // The client cannot show a form: hand the question to the assistant to ask aloud.
          clarification = { field, status: 'ask_user', question: question.title };
        }
      }

      const { check_id, outcome } = service.checkRequest(principal, input);
      const structured = {
        check_id,
        verdict: outcome.verdict,
        risk_signals: outcome.risk_signals,
        payee: outcome.payee,
        policy: outcome.policy,
        say_to_user: outcome.say_to_user,
        next_step: outcome.next_step,
        interpreted: {
          payment_method: outcome.effective_method,
          payment_method_source: outcome.method_source,
          contact_channel: input.contact_channel ?? 'unknown',
        },
        ...(clarification ? { clarification } : {}),
      };
      const signals = outcome.risk_signals.map((s) => s.label).join('; ') || 'none';
      return ok(
        structured,
        `${outcome.say_to_user}\n\nverdict: ${outcome.verdict} | payee: ${outcome.payee.status} | warning signs: ${signals} | next_step: ${outcome.next_step} | check_id: ${check_id}`,
      );
    }),
  );

  server.registerTool(
    'holdon_verify_payee',
    {
      title: 'Verify a payee',
      description:
        'Compare a payee name, and optionally a phone number, link or mailing address, with the registry of official payee facts. Returns verified, mismatch or not_in_registry with the official details and their sources. "not_in_registry" is an honest answer: the registry is small.',
      inputSchema: S.VerifyPayeeInput,
      outputSchema: S.VerifyPayeeOutput,
      annotations: { title: 'Verify a payee', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      icons: ICONS.check,
    },
    guard('holdon_verify_payee', (args) => {
      const result = service.verifyPayee(principal, args);
      return ok(result, `${result.say_to_user}\n\npayee: ${result.status}`);
    }),
  );

  registerAppTool(
    server,
    'holdon_place_hold',
    withCard(
      {
        title: 'Place a hold and ask family',
        description:
          'Put a money request on hold and notify the trusted family contact, who approves or denies it. Nothing is paid. Pass the check_id from holdon_check_request so the contact sees the full context. Calling it twice for the same check returns the same hold.',
        inputSchema: S.PlaceHoldInput,
        outputSchema: S.PlaceHoldOutput,
        annotations: { title: 'Place a hold and ask family', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        icons: ICONS.hold,
      },
      UI.hold,
    ),
    guard('holdon_place_hold', (args) => {
      const { hold, notified } = service.placeHold(principal, args);
      const say = service.placedMessage(hold);
      return ok(
        {
          hold_id: hold.id,
          status: hold.status,
          blocked: hold.blocked,
          notified,
          expires_at: hold.expires_at,
          say_to_user: say,
          next_step: 'wait' as const,
        },
        `${say}\n\nhold_id: ${hold.id} | status: ${hold.status} | notified: ${notified.map((n) => n.name).join(', ')} | expires_at: ${hold.expires_at}`,
      );
    }),
  );

  registerAppTool(
    server,
    'holdon_get_hold',
    withCard(
      {
        title: 'Check on a hold',
        description:
          'Look up one hold by id: its status (pending_family, approved, denied, expired, paid or cancelled), the trusted contact\'s decision and note, and what to say to the user. Works across sessions.',
        inputSchema: S.GetHoldInput,
        outputSchema: S.GetHoldOutput,
        annotations: { title: 'Check on a hold', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        icons: ICONS.hold,
      },
      UI.hold,
    ),
    guard('holdon_get_hold', (args) => {
      const view = service.memberHoldView(service.getHold(principal, args.hold_id));
      return ok(view, `${view.say_to_user}\n\nhold_id: ${view.hold_id} | status: ${view.status} | next_step: ${view.next_step}`);
    }),
  );

  server.registerTool(
    'holdon_list_holds',
    {
      title: 'List holds',
      description:
        "List the user's holds, newest first, optionally filtered by status. Use it at the start of a conversation to pick up where the last one left off, for example to tell the user that a hold was approved overnight.",
      inputSchema: S.ListHoldsInput,
      outputSchema: S.ListHoldsOutput,
      annotations: { title: 'List holds', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      icons: ICONS.hold,
    },
    guard('holdon_list_holds', (args) => {
      const holds = service.listHolds(principal, args).map((hold) => service.memberHoldView(hold));
      const waiting = holds.filter((h) => h.status === 'pending_family').length;
      const ready = holds.filter((h) => h.status === 'approved').length;
      const say =
        holds.length === 0
          ? 'There are no holds to show.'
          : `There ${holds.length === 1 ? 'is 1 hold' : `are ${holds.length} holds`}: ${waiting} waiting for an answer and ${ready} approved and ready to pay.`;
      const lines = holds.map((h) => `- ${h.hold_id}: ${h.status}${h.amount_usd !== undefined ? `, ${formatUsd(h.amount_usd)}` : ''}${h.payee_name ? ` to ${h.payee_name}` : ''}`);
      return ok({ holds, count: holds.length, say_to_user: say }, [say, ...lines].join('\n'));
    }),
  );

  registerAppTool(
    server,
    'holdon_wait_for_decision',
    withCard(
      {
        title: 'Wait for the family decision',
        description:
          'Wait up to timeout_seconds for the trusted contact to approve or deny a hold, sending MCP progress notifications while waiting. Returns the current status either way; timed_out is true if the hold is still pending. Call again to keep waiting.',
        inputSchema: S.WaitForDecisionInput,
        outputSchema: S.WaitForDecisionOutput,
        annotations: { title: 'Wait for the family decision', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        icons: ICONS.wait,
      },
      UI.hold,
    ),
    guard('holdon_wait_for_decision', async (args, ctx) => {
      const timeoutSeconds = args.timeout_seconds ?? 20;
      const progressToken = ctx.mcpReq._meta?.progressToken;
      const result = await service.waitForDecision(principal, args.hold_id, {
        timeoutMs: timeoutSeconds * 1000,
        intervalMs: options.progressIntervalMs ?? 2000,
        signal: ctx.mcpReq.signal,
        onTick: async (elapsedMs) => {
          if (progressToken === undefined) return;
          await ctx.mcpReq
            .notify({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: Math.min(Math.round(elapsedMs / 100) / 10, timeoutSeconds),
                total: timeoutSeconds,
                message: 'Waiting for the trusted contact to answer. Nothing has been paid.',
              },
            })
            .catch(() => undefined);
        },
      });
      const view = service.memberHoldView(result.hold);
      const waited = Math.round(result.waitedMs / 100) / 10;
      return ok(
        { ...view, waited_seconds: waited, timed_out: result.timedOut },
        `${view.say_to_user}\n\nhold_id: ${view.hold_id} | status: ${view.status} | waited_seconds: ${waited} | timed_out: ${result.timedOut} | next_step: ${view.next_step}`,
      );
    }),
  );

  registerAppTool(
    server,
    'holdon_pay',
    withCard(
      {
        title: 'Make the payment (simulated)',
        description:
          'Make a SIMULATED payment and return a receipt. Allowed only when the hold is approved, the payee is confirmed (official registry, or vouched for by the trusted contact) and the payment method is allowed. Give hold_id after family approval, or check_id when the check said next_step "pay". Otherwise it returns a clear error saying what is missing. No real money ever moves. Paying the same hold twice returns the same receipt.',
        inputSchema: S.PayInput,
        outputSchema: S.PayOutput,
        annotations: { title: 'Make the payment (simulated)', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        icons: ICONS.pay,
      },
      UI.receipt,
    ),
    guard('holdon_pay', (args) => {
      const { receipt } = service.pay(principal, args);
      const say = service.paidMessage(receipt);
      return ok({ ...service.receiptView(receipt), say_to_user: say }, `${say}\n\nreceipt_id: ${receipt.id} | hold_id: ${receipt.hold_id} | simulated: true`);
    }),
  );

  registerAppTool(
    server,
    'holdon_cancel_hold',
    withCard(
      {
        title: 'Cancel a hold',
        description: 'Cancel a hold the user no longer wants. Works while the hold is pending or approved; nothing is paid. Cancelling twice is harmless.',
        inputSchema: S.CancelHoldInput,
        outputSchema: S.CancelHoldOutput,
        annotations: { title: 'Cancel a hold', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        icons: ICONS.cancel,
      },
      UI.hold,
    ),
    guard('holdon_cancel_hold', (args) => {
      const view = service.memberHoldView(service.cancelHold(principal, args.hold_id));
      return ok(view, `${view.say_to_user}\n\nhold_id: ${view.hold_id} | status: ${view.status}`);
    }),
  );
}

function registerContactTools(server: McpServer, service: HoldOnService, principal: Principal, guard: Guard): void {
  registerAppTool(
    server,
    'holdon_family_inbox',
    withCard(
      {
        title: 'Family inbox',
        description:
          "See the money requests your family member has on hold, with full context: their own words, the warning signs and the official guidance behind each one, how the payee compares with official records, and whether you can approve. Details taken from the suspicious message are listed for context only; do not call or open them.",
        inputSchema: S.FamilyInboxInput,
        outputSchema: S.FamilyInboxOutput,
        annotations: { title: 'Family inbox', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        icons: ICONS.family,
      },
      UI.approval,
    ),
    guard('holdon_family_inbox', (args) => {
      const rows = service.familyInbox(principal, args);
      const holds = rows.map((hold) => service.familyHoldView(hold, principal.user_id));
      const pending = holds.filter((h) => h.status === 'pending_family').length;
      const say = service.inboxMessage(principal, pending);
      const lines = rows.map((hold, index) => {
        const view = holds[index]!;
        const signs = view.risk_signals.map((s) => s.label).join('; ') || 'no warning signs';
        return `- ${view.hold_id} [${view.status}] ${service.headline(hold)} | ${signs} | ${view.can_approve ? 'can approve or deny' : 'deny only'}`;
      });
      return ok({ holds, count: holds.length, say_to_user: say }, [say, ...lines].join('\n'));
    }),
  );

  registerAppTool(
    server,
    'holdon_family_decide',
    withCard(
      {
        title: 'Approve or deny a hold',
        description:
          'Approve or deny a hold for your family member. A request that Hold On stopped can only be denied. Approving a payee that is not in the official registry needs trust_payee: true, which records that you personally know them. Your note is read to your family member. Repeating the same decision is harmless; an approval can be changed to a denial until it is paid.',
        inputSchema: S.FamilyDecideInput,
        outputSchema: S.FamilyDecideOutput,
        annotations: { title: 'Approve or deny a hold', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        icons: ICONS.family,
      },
      UI.approval,
    ),
    guard('holdon_family_decide', (args) => {
      const { hold, trustedPayeeAdded } = service.familyDecide(principal, args);
      const view = service.familyHoldView(hold, principal.user_id);
      const say = service.decisionMessage(hold, args.decision, trustedPayeeAdded);
      return ok(
        {
          hold_id: hold.id,
          status: hold.status,
          decision: view.decision ?? { by: principal.name, at: hold.updated_at },
          payee_status: view.payee_status,
          trusted_payee_added: trustedPayeeAdded,
          say_to_user: say,
        },
        `${say}\n\nhold_id: ${hold.id} | status: ${hold.status}`,
      );
    }),
  );

  server.registerTool(
    'holdon_update_policy',
    {
      title: 'Change family settings',
      description:
        "Change the circle's safety settings: the amount at which confirmed payees need your approval, extra blocked payment methods, how long holds wait, and the family's list of confirmed payees. Gift cards and cryptocurrency to official payees are always blocked and cannot be switched off.",
      inputSchema: S.UpdatePolicyInput,
      outputSchema: S.UpdatePolicyOutput,
      annotations: { title: 'Change family settings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      icons: ICONS.policy,
    },
    guard('holdon_update_policy', (args) => {
      const { circle, changed } = service.updatePolicy(principal, args);
      const say =
        changed.length === 0
          ? 'Nothing needed changing; the settings were already like that.'
          : `Updated: ${changed.join(', ')}. Approval is now needed at ${formatUsd(circle.policy.approval_threshold_usd)} and above.`;
      return ok({ circle, changed, say_to_user: say }, say);
    }),
  );

  server.registerTool(
    'holdon_get_circle',
    {
      title: 'Family circle and settings',
      description:
        "See who is in the circle, the current safety settings (approval amount, blocked payment methods, hold expiry) and the family's list of confirmed payees.",
      inputSchema: S.GetCircleInput,
      outputSchema: S.GetCircleOutput,
      annotations: { title: 'Family circle and settings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      icons: ICONS.policy,
    },
    guard('holdon_get_circle', () => {
      const circle = service.getCircle(principal);
      const contacts = circle.contacts.map((c) => `${c.name}${c.relationship ? ` (${c.relationship})` : ''}`).join(', ');
      return ok(
        { circle },
        `${circle.name}: protects ${circle.members.map((m) => m.name).join(', ')}; trusted contact ${contacts}. Approval needed at ${formatUsd(circle.policy.approval_threshold_usd)} and above. Confirmed payees: ${circle.trusted_payees.map((t) => t.name).join(', ') || 'none yet'}.`,
      );
    }),
  );
}
