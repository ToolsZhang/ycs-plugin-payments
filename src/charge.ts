import { IModel, Model, Schema } from '@ycs/core/lib/db';
import { IDocsDataTypeProperties } from '@ycs/core/lib/docs';
import { IContext } from '@ycs/core/lib/context';
import { Boom } from '@ycs/core/lib/errors';
import {
  Client,
  TradeAppPayRequest,
  TradePagePayRequest,
  EProductCode,
  Request,
} from '@ycnt/alipay';
import { Wechatpay, IOrderParams } from '@ycnt/wechatpay';
import * as ip6addr from 'ip6addr';
import { IRefundDocument } from './refund';
import { getWebhook } from './webhook';

/**
 * All models
 */
export const models: Array<{
  path: string;
  model: IModel;
}> = [];

/**
 * Creating a model
 * @param payment {IPayment} IPayment
 */
export function createModel(payment: IPayment): IModel {
  const schema = new Schema(
    {
      channel: {
        type: String,
        require: true,
        enum: payment.channels,
      },
      currency: {
        type: String,
        require: true,
        enum: payment.currencies,
      },
      device: {
        type: String,
        enum: ['app', 'wap', 'web'],
        default: 'app',
      },
      client_ip: {
        type: String,
        require: true,
      },
      subject: {
        type: String,
        require: true,
      },
      body: {
        type: String,
        require: true,
      },
      amount: {
        type: Number,
        require: true,
      },
      return_url: String,
      openid: String,
      extra: {},
      paid: {
        type: Boolean,
        default: false,
      },
    },
    {
      timestamps: {},
    }
  );
  const model = Model({
    name: '__payments_charge_' + payment.path,
    schema,
    auth: true,
  });
  models.push({ path: payment.path, model: model });
  return model;
}

/**
 * Get model by given path
 * @param path {string} path
 */
export function getModel(path: string): IModel {
  const model = models.find(x => x.path === path);
  if (model) return model.model;
  return null;
}

export enum EChannel {
  /**
   * Alipay
   */
  alipay = 'alipay',
  /**
   * Wechatpay
   */
  wechatpay = 'wechatpay',
  /**
   * mppay
   */
  mppay = 'mppay',
  /**
   * minigrampay
   */
  minigrampay = 'minigrampay',
}

export enum ECurrency {
  /**
   * Chinese RMB
   */
  cny = 'cny',
}

export interface IChargeDocument {
  /**
   * Payment channel
   */
  channel: EChannel;

  /**
   * Payment device default app
   */
  device?: 'app' | 'wap' | 'web';

  /**
   * Payment currency
   */
  currency: ECurrency;

  /**
   * Remote ip
   */
  client_ip: string;

  /**
   * Payment subject
   */
  subject: string;

  /**
   * Payment body
   */
  body: string;

  /**
   * Payment amount
   */
  amount: number;

  /**
   * Extra fields. It will be passed to webhook after payment.
   */
  extra?: {
    [x: string]: any;
  };

  /**
   * Return url. for Webpage only.
   */
  return_url?: string;

  /**
   * user openid. for JSAPI only.
   */
  openid?: string;

  /**
   * Auth id
   */
  __auth: string;
}

export interface IPayment {
  /**
   * Payment path. eg. 'order'
   */
  path: string;

  /**
   * For testing
   */
  test?: boolean;

  /**
   * Allowed channels
   */
  channels: EChannel[];

  /**
   * Allowed currencies
   */
  currencies: ECurrency[];

  /**
   * Request parameters
   */
  parameters: IDocsDataTypeProperties;

  /**
   * Charge params generator
   */
  charge: (ctx: IContext) => Promise<IChargeDocument>;

  /**
   * Charge webhook. Executing after paid.
   */
  chargeWebhook: (doc: IChargeDocument) => Promise<void>;

  /**
   * Alipay client
   */
  alipayClient?: Client;

  /**
   * Wechatpay client
   */
  wechatpayClient?: Wechatpay;

  /**
   * mppay client
   */
  mppayClient?: Wechatpay;

  /**
   * minigrampay client
   */
  minigrampayClient?: Wechatpay;

  /**
   * Using https
   */
  https?: boolean;

  /**
   * Enable refund
   */
  refund?: (refund: IRefundDocument, charge: IChargeDocument) => Promise<void>;
}

export async function charge(
  payment: IPayment,
  doc: IChargeDocument
): Promise<any> {
  const model = getModel(payment.path);
  const entity = await model.create(doc);
  return createCharge(payment, entity);
}

async function createCharge(payment: IPayment, entity: any): Promise<any> {
  if (payment.test) {
    const webhook = getWebhook(payment.path);
    const webhookUrl =
      webhook.prefix + '/pay/' + entity.channel + '/test/' + entity._id;
    return {
      isYcsTest: true,
      webhook: webhookUrl,
      charge: entity,
    };
  }
  switch (entity.channel) {
    case EChannel.alipay:
      return createChargeForAlipay(payment, entity);
    case EChannel.wechatpay:
    case EChannel.mppay:
    case EChannel.minigrampay:
      return createChargeForWechatpay(payment, entity);
    default:
      throw Boom.badData('Unsupported payment method');
  }
}

async function createChargeForAlipay(
  payment: IPayment,
  entity: any
): Promise<any> {
  let req: any;
  switch (entity.device) {
    case 'web':
      req = new TradePagePayRequest();
      req.setBizContent({
        subject: entity.subject,
        out_trade_no: entity._id,
        total_amount: entity.amount.toString(),
        body: entity.body,
        product_code: EProductCode.FAST_INSTANT_TRADE_PAY,
      });
      req.data.return_url = entity.return_url;
      break;
    default:
      req = new TradeAppPayRequest();
      req.setBizContent({
        subject: entity.subject,
        out_trade_no: entity._id,
        total_amount: entity.amount.toString(),
        body: entity.body,
      });
  }
  const webhook = getWebhook(payment.path);
  req.data.notify_url = webhook.prefix + '/pay/' + entity.channel;
  const charge = payment.alipayClient.generateRequestParams(req);
  return {
    isYcsTest: false,
    channel: entity.channel,
    charge: charge,
  };
}

async function createChargeForWechatpay(
  payment: IPayment,
  entity: any
): Promise<any> {
  const webhook = getWebhook(payment.path);
  const params: IOrderParams = {
    body: entity.subject,
    out_trade_no: entity._id.toString(),
    total_fee: Math.ceil(entity.amount * 100),
    spbill_create_ip: ip6addr
      .parse(entity.client_ip)
      .toString({ format: 'v4' }),
    notify_url: webhook.prefix + '/pay/' + entity.channel,
    trade_type: entity.channel === EChannel.wechatpay ? 'APP' : 'JSAPI',
  };

  let order;
  let charge;
  switch (entity.channel) {
    case EChannel.wechatpay:
      order = await payment.wechatpayClient.createUnifiedOrder(params);
      charge = payment.wechatpayClient.configForPayment(order);
      break;
    case EChannel.mppay:
      params.openid = entity.openid;
      order = await payment.mppayClient.createUnifiedOrder(params);
      console.log('order', order);
      charge = payment.mppayClient.configForPayment(order);
      break;
    case EChannel.minigrampay:
      params.openid = entity.openid;
      order = await payment.minigrampayClient.createUnifiedOrder(params);
      console.log('order', order);
      charge = payment.minigrampayClient.configForPayment(order);
      break;
  }
  return {
    isYcsTest: false,
    channel: entity.channel,
    charge: charge,
  };
}
