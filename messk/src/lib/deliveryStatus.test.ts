import { describe, expect, it } from 'vitest';
import { getDeliveryStatusPresentation } from './deliveryStatus';

describe('delivery status presentation', () => {
  it('maps direct message states to user-facing labels and descriptions', () => {
    expect(getDeliveryStatusPresentation('pending')).toMatchObject({
      label: 'pending',
      tone: 'pending',
    });
    expect(getDeliveryStatusPresentation('failed')).toMatchObject({
      label: 'error',
      tone: 'danger',
    });
    expect(getDeliveryStatusPresentation('read')).toMatchObject({
      label: 'read',
      tone: 'success',
    });
    expect(getDeliveryStatusPresentation('delivered').description).toMatch(/acknowledged/i);
  });

  it('does not imply group read receipts', () => {
    const delivered = getDeliveryStatusPresentation('delivered', { isGroupMessage: true });
    const read = getDeliveryStatusPresentation('read', { isGroupMessage: true });

    expect(delivered.label).toBe('distributed');
    expect(read.label).toBe('distributed');
    expect(read.description).toMatch(/read receipts are not implied/i);
  });
});
