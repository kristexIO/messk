import type { StoredMessage } from './db';

export type DeliveryStatusPresentation = {
  label: string;
  description: string;
  tone: 'neutral' | 'pending' | 'success' | 'danger';
};

export function getDeliveryStatusPresentation(
  status: StoredMessage['status'],
  options: { isGroupMessage?: boolean } = {}
): DeliveryStatusPresentation {
  switch (status) {
    case 'pending':
      return {
        label: 'pending',
        description: 'Message is encrypted locally and waiting for a successful send attempt.',
        tone: 'pending',
      };
    case 'failed':
      return {
        label: 'error',
        description: 'Message was not delivered. Use retry after checking the connection.',
        tone: 'danger',
      };
    case 'read':
      if (options.isGroupMessage) {
        return {
          label: 'distributed',
          description: 'Message was delivered to the group delivery path. Group read receipts are not implied.',
          tone: 'success',
        };
      }
      return {
        label: 'read',
        description: 'Recipient client reported the message as read.',
        tone: 'success',
      };
    case 'delivered':
      return {
        label: options.isGroupMessage ? 'distributed' : 'delivered',
        description: options.isGroupMessage
          ? 'Message was accepted by the group delivery path.'
          : 'Recipient device acknowledged delivery.',
        tone: 'success',
      };
    case 'sent':
    default:
      return {
        label: 'sent',
        description: 'Server accepted the encrypted message for delivery.',
        tone: 'neutral',
      };
  }
}
