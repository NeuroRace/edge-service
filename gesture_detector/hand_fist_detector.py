import os
import time
import cv2
from broker_client import StatusTicker, WebSocketBrokerClient, gesture_status_payload
from code_version import code_version, git_info
import mediapipe as mp

class HandFistDetector:
    def __init__(self, min_detection_confidence=0.7, min_tracking_confidence=0.6,
                 consecutive_frames_for_event=5):
        self.mp_hands = mp.solutions.hands
        self.hands = self.mp_hands.Hands(
            max_num_hands=1,
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )
        self.mp_drawing = mp.solutions.drawing_utils

        # IDs das pontas dos dedos (tip) – exceto o polegar
        self.finger_tips = [8, 12, 16, 20]  # indicador, médio, anelar, mínimo

        # Quantos frames consecutivos exigimos pra considerar "punho fechado"
        self.consecutive_frames_for_event = consecutive_frames_for_event
        self.closed_counter = 0
        self.last_state_closed = False
        # NEU-139: mao vista no ultimo frame (vai no gestureStatus para o painel).
        self.last_hand_seen = False

    def _is_fist(self, hand_landmarks) -> bool:
        """
        Retorna True se a mão estiver fechada (punho), considerando
        os dedos indicador, médio, anelar e mínimo dobrados.
        """
        lm = hand_landmarks.landmark
        folded_count = 0

        for tip_id in self.finger_tips:
            tip = lm[tip_id]
            pip = lm[tip_id - 2]  # articulação logo antes da ponta (PIP)

            # Se a ponta está abaixo da articulação -> dedo dobrado
            if tip.y > pip.y:
                folded_count += 1

        # Considera punho se os 4 dedos estiverem dobrados
        return folded_count == len(self.finger_tips)

    def process_frame(self, frame):
        """
        Processa um frame BGR do OpenCV.
        Retorna:
          - frame_annotated: frame com as marcações dos pontos da mão
          - is_closed: bool indicando se a mão está fechada AGORA
          - event_closed: bool que só é True no frame em que a mão
                          acabou de ser detectada como fechada (borda de subida)
        """
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.hands.process(rgb)
        self.last_hand_seen = bool(results.multi_hand_landmarks)
        is_closed = False
        event_closed = False

        if results.multi_hand_landmarks:
            for hand_landmarks in results.multi_hand_landmarks:
                # Desenha a mão no frame para debug / visualização
                self.mp_drawing.draw_landmarks(
                    frame,
                    hand_landmarks,
                    self.mp_hands.HAND_CONNECTIONS
                )

                if self._is_fist(hand_landmarks):
                    is_closed = True
                else:
                    is_closed = False

                # Só analisamos a primeira mão (max_num_hands = 1)
                break

        # Lógica de histerese: exige N frames fechados
        if is_closed:
            self.closed_counter += 1
        else:
            self.closed_counter = 0

        current_state_closed = self.closed_counter >= self.consecutive_frames_for_event

        # Evento de "acabou de fechar a mão" (transição False -> True)
        if current_state_closed and not self.last_state_closed:
            event_closed = True

        self.last_state_closed = current_state_closed

        return frame, current_state_closed, event_closed


def main():
    print("Iniciando captura da webcam. Pressione 'q' para sair.")

    PLAYER_ID = int(os.getenv('PLAYER_ID', '1'))
    BROKER_URL = os.getenv('BROKER_URL', 'http://localhost:3000')
    # NEU-142: indice da camera vem de CAMERA_INDEX (padrao 0, como antes); vai no Diagnostico.
    CAMERA_INDEX = int(os.getenv('CAMERA_INDEX', '0'))
    cap = cv2.VideoCapture(CAMERA_INDEX)
    detector = HandFistDetector(consecutive_frames_for_event=5)
    meta = {"version": code_version(), "camera": CAMERA_INDEX, **git_info()}
    
    status_ticker = StatusTicker()

    with WebSocketBrokerClient(BROKER_URL, PLAYER_ID, meta=meta) as broker:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Não foi possível ler da webcam.")
                break

            frame, is_closed, event_closed = detector.process_frame(frame)

            # NEU-139: sinal de vida a cada 2 s (o painel distingue gesto parado de gesto morto).
            if status_ticker.due():
                broker.send_event("gestureStatus", gesture_status_payload(PLAYER_ID, detector.last_hand_seen, int(time.time() * 1000)))

            # Mostra o estado atual na tela
            status_text = "PUNHO FECHADO" if is_closed else "MAO ABERTA/INDEFINIDA"
            cv2.putText(frame, status_text, (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)

            cv2.imshow("Deteccao de Punho - Pressione 'q' para sair", frame)

            if event_closed:
                now_ms = int(time.time() * 1000)

                # send_event nao levanta excecao: com o broker fora, o evento e descartado.
                if broker.send_event("handGesture", {'player': PLAYER_ID, 'timeStamp': now_ms}):
                    print(f"[EVENTO] Punho fechado de player {PLAYER_ID} detectado! Enviado ao Broker em {BROKER_URL}")
                else:
                    print(f"[WARN] Punho do player {PLAYER_ID} nao enviado: Broker fora ({BROKER_URL})")
                

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
