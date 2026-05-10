import { ExpressFunction } from "../interfaces/helper.interface";
import {
  createAISessionService,
  listAISessionsService,
  getAISessionService,
  processTurnService,
  completeAISessionService,
  getTeacherPrepNoteService,
} from "../services/esolAISession.service";
export const createSession: ExpressFunction = async (req, res, next) => {
  try {
    const body = req.body as any;
    const data = await createAISessionService({
      learnerId: body.learnerId,
      teacherId: body.teacherId,
      bookingId: body.bookingId,
      sessionMode: body.sessionMode,
      topic: body.topic,
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

export const listSessions: ExpressFunction = async (req, res, next) => {
  try {
    const query = req.query as any;
    const data = await listAISessionsService({
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
      page: query.page,
      limit: query.limit,
      learnerId: query.learnerId,
      teacherId: query.teacherId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getSession: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getAISessionService({
      sessionId: params.sessionId,
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const submitTurn: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const body = req.body as any;
    const data = await processTurnService({
      sessionId: params.sessionId,
      learnerId: req.user!.id.toString(),
      input: body.input,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const completeSession: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await completeAISessionService({
      sessionId: params.sessionId,
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getTeacherPrep: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getTeacherPrepNoteService({
      sessionId: params.sessionId,
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

// Session-token routes removed in pivot — Vertex EU keeps data in EU,
// no separate session token gating layer needed for v2.
