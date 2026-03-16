from acquisition_config import configure_logging, load_config
from acquisition_runner import run_acquisition_service


def start_acquisition_service():
    log = configure_logging()
    config = load_config()
    run_acquisition_service(config, log)


if __name__ == '__main__':
    start_acquisition_service()
